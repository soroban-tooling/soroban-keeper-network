//! Minimal Soroban JSON-RPC client — just the methods the ingest loop
//! needs (`getHealth`, `getEvents`; the lag work in 0231 adds
//! `getLatestLedger`), speaking JSON-RPC 2.0
//! over HTTP directly rather than pulling in a full SDK: the indexer never
//! builds or signs a transaction, and the response shapes it reads are small
//! and stable.

use serde::Deserialize;
use serde_json::{json, Value};

pub struct RpcClient {
    http: reqwest::Client,
    url: String,
}

#[derive(Debug)]
pub enum RpcError {
    /// The HTTP round-trip failed (connect, timeout, non-2xx).
    Transport(String),
    /// The endpoint answered with a JSON-RPC error object.
    Rpc(String),
    /// The response decoded, but not into the shape this client expects.
    Shape(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Transport(e) => write!(f, "rpc transport: {e}"),
            RpcError::Rpc(e) => write!(f, "rpc error: {e}"),
            RpcError::Shape(e) => write!(f, "rpc response shape: {e}"),
        }
    }
}

/// One raw contract event exactly as the RPC serves it. Topics and value stay
/// XDR base64 — the scaffold observes and logs, it does not parse (that is
/// 0220 onward, per docs/INDEXER_DESIGN.md).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEvent {
    /// TOID-derived event id — the design's uniqueness key.
    pub id: String,
    pub ledger: u32,
    pub contract_id: String,
    pub topic: Vec<String>,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    #[serde(default)]
    pub events: Vec<RawEvent>,
    pub latest_ledger: u32,
    /// Paging cursor for the next call; absent on older RPC versions.
    #[serde(default)]
    pub cursor: Option<String>,
}

impl RpcClient {
    pub fn new(url: &str) -> Self {
        RpcClient {
            // A hung request must fail, not park the whole ingest loop (and
            // with it the health endpoint's picture of the world) forever.
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("static client config"),
            url: url.to_string(),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let res = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| RpcError::Transport(e.to_string()))?;
        let status = res.status();
        if !status.is_success() {
            return Err(RpcError::Transport(format!("HTTP {status}")));
        }
        let envelope: Value = res
            .json()
            .await
            .map_err(|e| RpcError::Shape(e.to_string()))?;
        if let Some(err) = envelope.get("error") {
            return Err(RpcError::Rpc(err.to_string()));
        }
        envelope
            .get("result")
            .cloned()
            .ok_or_else(|| RpcError::Shape("missing result".into()))
    }

    pub async fn get_health(&self) -> Result<(), RpcError> {
        let result = self.call("getHealth", json!({})).await?;
        match result.get("status").and_then(Value::as_str) {
            Some("healthy") => Ok(()),
            other => Err(RpcError::Rpc(format!("unhealthy endpoint: {other:?}"))),
        }
    }

    /// One page of events for `contract_id`. `start` is used on the first
    /// request of a run; afterwards pass the returned `cursor` instead — the
    /// RPC treats the two parameters as mutually exclusive.
    pub async fn get_events(
        &self,
        contract_id: &str,
        start: Start<'_>,
        limit: u32,
    ) -> Result<EventsPage, RpcError> {
        let mut params = json!({
            "filters": [{ "type": "contract", "contractIds": [contract_id] }],
            "pagination": { "limit": limit },
        });
        match start {
            Start::Ledger(n) => params["startLedger"] = json!(n),
            Start::Cursor(c) => params["pagination"]["cursor"] = json!(c),
        }
        let result = self.call("getEvents", params).await?;
        serde_json::from_value(result).map_err(|e| RpcError::Shape(e.to_string()))
    }
}

/// Where a `getEvents` call resumes from.
pub enum Start<'a> {
    Ledger(u32),
    Cursor(&'a str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_page_decodes_the_rpc_shape() {
        // A trimmed real-shaped getEvents result: base64 XDR stays opaque.
        let raw = serde_json::json!({
            "events": [{
                "type": "contract",
                "ledger": 4545,
                "ledgerClosedAt": "2026-08-30T00:00:00Z",
                "contractId": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                "id": "0000019519413221376-0000000000",
                "topic": ["AAAADwAAAANyZWcA", "AAAADwAAAAR0YXNr"],
                "value": "AAAAEAAAAAE=",
                "inSuccessfulContractCall": true,
                "txHash": "deadbeef"
            }],
            "latestLedger": 4600,
            "cursor": "0000019519413221376-0000000001"
        });
        let page: EventsPage = serde_json::from_value(raw).expect("decodes");
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].ledger, 4545);
        assert_eq!(page.events[0].id, "0000019519413221376-0000000000");
        assert_eq!(page.latest_ledger, 4600);
        assert_eq!(
            page.cursor.as_deref(),
            Some("0000019519413221376-0000000001")
        );
    }

    #[test]
    fn events_page_tolerates_an_empty_result_without_cursor() {
        // Older RPC versions omit `cursor`; an idle contract omits `events`.
        let raw = serde_json::json!({ "latestLedger": 4600 });
        let page: EventsPage = serde_json::from_value(raw).expect("decodes");
        assert!(page.events.is_empty());
        assert_eq!(page.cursor, None);
//! The Soroban RPC surface the indexer depends on.
//!
//! Ingestion is defined against the [`EventSource`] trait rather than a
//! concrete HTTP client, so backfill and steady-state polling can both be
//! tested deterministically against a fixture source. The design document
//! chose polling `getEvents` -- the same mechanism the keeper-bot already
//! uses -- over a streaming subscription, because no Soroban RPC provider
//! offers a durable stream that survives a reconnect without replay anyway.

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// A scalar in an event payload, in the shapes the registry actually emits.
///
/// This is deliberately not a general XDR value type: the contract emits only
/// these six, and a narrow enum makes a payload-shape change a compile error
/// in `parse.rs` rather than a runtime surprise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RawValue {
    U32(u32),
    U64(u64),
    I128(i128),
    Bool(bool),
    /// Stellar strkey address.
    Address(String),
    /// Hex-encoded bytes.
    Bytes(String),
}

/// One event as the RPC returns it, before typed parsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvent {
    pub ledger: u32,
    pub ledger_close_time: i64,
    pub tx_hash: String,
    pub event_index: u32,
    /// The `(verb, noun)` topic pair, as symbols.
    pub topics: Vec<String>,
    /// Payload fields, in the order the contract published them.
    pub values: Vec<RawValue>,
}

/// One page of events from a ledger range.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventPage {
    pub events: Vec<RawEvent>,
    /// Highest ledger this page covers; ingestion checkpoints on it.
    pub latest_ledger_scanned: u32,
}

/// A source of contract events over a ledger range.
#[allow(async_fn_in_trait)]
pub trait EventSource {
    /// Fetch events for `contract_id` in `[start_ledger, start_ledger + limit)`.
    async fn get_events(
        &self,
        contract_id: &str,
        start_ledger: u32,
        limit: u32,
    ) -> Result<EventPage>;

    /// The current chain tip, so backfill knows when it has caught up.
    async fn latest_ledger(&self) -> Result<u32>;
}

#[cfg(test)]
pub mod fixture {
    //! An in-memory [`EventSource`] for deterministic tests.

    use super::*;
    use std::sync::{Arc, Mutex};

    /// A fixed set of events, served by ledger range.
    #[derive(Clone, Default)]
    pub struct FixtureSource {
        events: Vec<RawEvent>,
        tip: u32,
        /// Ledger at which the next `get_events` call fails, simulating an
        /// interrupted backfill.
        fail_at: Arc<Mutex<Option<u32>>>,
        /// Number of `get_events` calls served, for asserting page counts.
        calls: Arc<Mutex<usize>>,
    }

    impl FixtureSource {
        pub fn new(events: Vec<RawEvent>, tip: u32) -> Self {
            Self {
                events,
                tip,
                fail_at: Arc::new(Mutex::new(None)),
                calls: Arc::new(Mutex::new(0)),
            }
        }

        /// Make the next request covering `ledger` fail once.
        pub fn fail_once_at(&self, ledger: u32) {
            *self.fail_at.lock().expect("fixture lock") = Some(ledger);
        }

        pub fn call_count(&self) -> usize {
            *self.calls.lock().expect("fixture lock")
        }
    }

    impl EventSource for FixtureSource {
        async fn get_events(
            &self,
            _contract_id: &str,
            start_ledger: u32,
            limit: u32,
        ) -> Result<EventPage> {
            *self.calls.lock().expect("fixture lock") += 1;

            let end = start_ledger.saturating_add(limit);
            {
                let mut fail_at = self.fail_at.lock().expect("fixture lock");
                if let Some(ledger) = *fail_at {
                    if ledger >= start_ledger && ledger < end {
                        *fail_at = None;
                        anyhow::bail!("simulated RPC failure at ledger {ledger}");
                    }
                }
            }

            let events: Vec<RawEvent> = self
                .events
                .iter()
                .filter(|e| e.ledger >= start_ledger && e.ledger < end)
                .cloned()
                .collect();

            Ok(EventPage {
                events,
                latest_ledger_scanned: end.saturating_sub(1).min(self.tip),
            })
        }

        async fn latest_ledger(&self) -> Result<u32> {
            Ok(self.tip)
        }
    }
}
