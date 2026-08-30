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
    }
}
