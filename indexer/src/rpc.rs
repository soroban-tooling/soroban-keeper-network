//! The Soroban RPC surface the indexer depends on.
//!
//! Ingestion is defined against the [`EventSource`] trait rather than a
//! concrete HTTP client, so backfill and steady-state polling can both be
//! tested deterministically against a fixture source. The design document
//! chose polling `getEvents` -- the same mechanism the keeper-bot already
//! uses -- over a streaming subscription, because no Soroban RPC provider
//! offers a durable stream that survives a reconnect without replay anyway.
//!
//! [`HttpClient`] is the one real implementation: a minimal JSON-RPC 2.0
//! client speaking directly to a Soroban RPC endpoint's `getHealth`,
//! `getEvents`, and `getLatestLedger` methods. It decodes each event's
//! base64 XDR topics and value into the typed [`RawValue`] shapes
//! `ingest::parse` expects, so nothing downstream of this module ever
//! touches base64 or XDR directly.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use stellar_xdr::curr::{Limits, ReadXdr, ScAddress, ScVal};

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

/// A minimal JSON-RPC 2.0 client for the one Soroban RPC endpoint the
/// indexer talks to. Not a general-purpose Soroban SDK client: the indexer
/// never builds or signs a transaction, so it has no need for one.
pub struct HttpClient {
    http: reqwest::Client,
    url: String,
}

impl HttpClient {
    pub fn new(url: &str) -> Self {
        HttpClient {
            // A hung request must fail, not park the whole ingest loop (and
            // with it the health endpoint's picture of the world) forever.
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("static client config"),
            url: url.to_string(),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let res = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("rpc transport failure calling {method}"))?;
        let status = res.status();
        if !status.is_success() {
            return Err(anyhow!("rpc transport: HTTP {status} calling {method}"));
        }
        let envelope: Value = res
            .json()
            .await
            .with_context(|| format!("rpc response for {method} was not valid JSON"))?;
        if let Some(err) = envelope.get("error") {
            return Err(anyhow!("rpc error calling {method}: {err}"));
        }
        envelope
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("rpc response for {method} had no result field"))
    }

    /// Fails if the endpoint does not report itself healthy. Called once at
    /// startup so a misconfigured `INDEXER_RPC_URL` is caught immediately,
    /// not on the first real `getEvents` call deep in the ingest loop.
    pub async fn get_health(&self) -> Result<()> {
        let result = self.call("getHealth", json!({})).await?;
        match result.get("status").and_then(Value::as_str) {
            Some("healthy") => Ok(()),
            other => Err(anyhow!("unhealthy rpc endpoint: {other:?}")),
        }
    }
}

/// The `getEvents` response shape, before XDR decoding.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEventsPage {
    #[serde(default)]
    events: Vec<RawRpcEvent>,
    latest_ledger: u32,
}

/// One event exactly as `getEvents` serves it: topics and value are still
/// base64 XDR, and the event's index within its ledger is folded into `id`
/// as a TOID-derived string (`<toid>-<index>`) rather than its own field.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRpcEvent {
    id: String,
    ledger: u32,
    ledger_closed_at: String,
    tx_hash: String,
    topic: Vec<String>,
    value: String,
}

/// The trailing `-<index>` segment of a TOID-derived event id is the event's
/// position within its ledger. Malformed input maps to `0` rather than
/// failing the whole page: the index is a display/ordering aid, not part of
/// any invariant ingestion depends on.
fn event_index_from_id(id: &str) -> u32 {
    id.rsplit('-')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn decode_symbol(b64: &str) -> Result<String> {
    let val = ScVal::from_xdr_base64(b64, Limits::none())
        .with_context(|| format!("topic {b64:?} is not valid XDR"))?;
    match val {
        ScVal::Symbol(sym) => Ok(sym.0.to_string()),
        other => Err(anyhow!("expected a Symbol topic, got {other:?}")),
    }
}

fn decode_address(addr: &ScAddress) -> String {
    match addr {
        ScAddress::Account(account_id) => {
            let stellar_xdr::curr::PublicKey::PublicKeyTypeEd25519(key) = &account_id.0;
            stellar_strkey::ed25519::PublicKey(key.0).to_string()
        }
        ScAddress::Contract(hash) => stellar_strkey::Contract(hash.0).to_string(),
    }
}

fn decode_scval(val: ScVal) -> Result<RawValue> {
    match val {
        ScVal::U32(v) => Ok(RawValue::U32(v)),
        ScVal::U64(v) => Ok(RawValue::U64(v)),
        ScVal::I128(parts) => {
            let hi = i128::from(parts.hi);
            let lo = i128::from(parts.lo);
            Ok(RawValue::I128((hi << 64) | lo))
        }
        ScVal::Bool(v) => Ok(RawValue::Bool(v)),
        ScVal::Address(addr) => Ok(RawValue::Address(decode_address(&addr))),
        ScVal::Bytes(b) => Ok(RawValue::Bytes(hex::encode(b.0.to_vec()))),
        other => Err(anyhow!(
            "unexpected value shape in event payload: {other:?}"
        )),
    }
}

/// Decodes the base64 `value` field into the flat list of [`RawValue`]s the
/// contract published, per `e.events().publish(topics, (data...))`. The
/// contract always publishes a tuple, which XDR-encodes as `ScVal::Vec`; a
/// single non-tuple value would mean the contract's event shape changed
/// underneath the indexer, so that case is an error, not silently wrapped.
fn decode_values(b64: &str) -> Result<Vec<RawValue>> {
    let val = ScVal::from_xdr_base64(b64, Limits::none())
        .with_context(|| format!("event value {b64:?} is not valid XDR"))?;
    match val {
        ScVal::Vec(Some(vec)) => vec.0.to_vec().into_iter().map(decode_scval).collect(),
        other => Err(anyhow!("expected a Vec of payload fields, got {other:?}")),
    }
}

fn decode_event(raw: RawRpcEvent) -> Result<RawEvent> {
    let topics = raw
        .topic
        .iter()
        .map(|t| decode_symbol(t))
        .collect::<Result<Vec<String>>>()
        .with_context(|| format!("decoding topics for event {}", raw.id))?;
    let values = decode_values(&raw.value)
        .with_context(|| format!("decoding value for event {}", raw.id))?;
    let ledger_close_time = chrono::DateTime::parse_from_rfc3339(&raw.ledger_closed_at)
        .with_context(|| format!("event {} has an unparseable ledgerClosedAt", raw.id))?
        .timestamp();
    Ok(RawEvent {
        ledger: raw.ledger,
        ledger_close_time,
        tx_hash: raw.tx_hash,
        event_index: event_index_from_id(&raw.id),
        topics,
        values,
    })
}

impl EventSource for HttpClient {
    async fn get_events(
        &self,
        contract_id: &str,
        start_ledger: u32,
        limit: u32,
    ) -> Result<EventPage> {
        let params = json!({
            "startLedger": start_ledger,
            "filters": [{ "type": "contract", "contractIds": [contract_id] }],
            "pagination": { "limit": limit },
        });
        let result = self.call("getEvents", params).await?;
        let page: RawEventsPage =
            serde_json::from_value(result).context("getEvents response had an unexpected shape")?;
        let events = page
            .events
            .into_iter()
            .map(decode_event)
            .collect::<Result<Vec<RawEvent>>>()?;
        Ok(EventPage {
            events,
            latest_ledger_scanned: page.latest_ledger,
        })
    }

    async fn latest_ledger(&self) -> Result<u32> {
        let result = self.call("getLatestLedger", json!({})).await?;
        result
            .get("sequence")
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .ok_or_else(|| anyhow!("getLatestLedger response had no sequence field"))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_index_parses_the_toid_suffix() {
        assert_eq!(event_index_from_id("0000019519413221376-0000000042"), 42);
        assert_eq!(event_index_from_id("not-a-toid-3"), 3);
        assert_eq!(event_index_from_id("garbage"), 0);
    }

    #[test]
    fn decode_symbol_rejects_a_non_symbol_value() {
        // XDR for ScVal::U32(1) -- a validly-encoded value of the wrong type.
        let u32_one_b64 = "AAAAAwAAAAE=";
        let err = decode_symbol(u32_one_b64).unwrap_err();
        assert!(err.to_string().contains("Symbol"));
    }
}
