//! Ingestion lag as a monitorable signal (issue 0231).
//!
//! From the outside, a stalled indexer looks identical to a healthy-but-quiet
//! one: both go silent. The difference is visible only as the gap between the
//! network's current latest ledger and the latest ledger this service has
//! fully ingested — so that gap, in ledgers, is the metric, updated on every
//! ingestion cycle and served over a health endpoint with an explicit
//! healthy/unhealthy verdict against a configurable threshold
//! (`INDEXER_MAX_LAG_LEDGERS`).
//!
//! The endpoint is deliberately tiny — one hand-written HTTP response on a
//! tokio listener, no framework: the REST API issue (0225) will pick the
//! web stack for the real query surface and absorb this route; a health
//! probe should not be the thing that forces that choice early. E18's
//! observability epic can later re-export the same tracker in whatever
//! metrics format it standardizes on.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Shared between the ingest loop (writer) and the health endpoint (reader).
/// Plain atomics: both sides touch two u32s, and a lock would only add a
/// failure mode to the thing whose job is reporting failure.
#[derive(Debug, Default)]
pub struct LagTracker {
    latest: AtomicU32,
    ingested: AtomicU32,
}

/// One health verdict, computed at read time from the tracker's counters.
#[derive(Debug, PartialEq, Eq)]
pub struct Health {
    pub latest_ledger: u32,
    pub last_ingested_ledger: u32,
    pub lag_ledgers: u32,
    pub max_lag_ledgers: u32,
    pub healthy: bool,
}

impl LagTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The network tip, as of the most recent successful RPC exchange. The
    /// loop reports this even on cycles whose event fetch failed (via a
    /// separate `getLatestLedger`), so a stalled ingest path cannot freeze
    /// the tip and hide its own lag.
    pub fn observe_latest(&self, ledger: u32) {
        self.latest.fetch_max(ledger, Ordering::Relaxed);
    }

    /// The last ledger whose events are fully ingested.
    pub fn observe_ingested(&self, ledger: u32) {
        self.ingested.fetch_max(ledger, Ordering::Relaxed);
    }

    pub fn health(&self, max_lag_ledgers: u32) -> Health {
        let latest = self.latest.load(Ordering::Relaxed);
        let ingested = self.ingested.load(Ordering::Relaxed);
        let lag = latest.saturating_sub(ingested);
        Health {
            latest_ledger: latest,
            last_ingested_ledger: ingested,
            lag_ledgers: lag,
            max_lag_ledgers,
            // Before the first successful cycle both counters are zero; that
            // is "unknown", and unknown must not read as healthy.
            healthy: latest > 0 && lag <= max_lag_ledgers,
        }
    }
}

impl Health {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"healthy\":{},\"lag_ledgers\":{},\"latest_ledger\":{},\
             \"last_ingested_ledger\":{},\"max_lag_ledgers\":{}}}",
            self.healthy,
            self.lag_ledgers,
            self.latest_ledger,
            self.last_ingested_ledger,
            self.max_lag_ledgers
        )
    }
}

/// Serve `GET /health` forever. Any request path gets the health document —
/// the listener exists for probes, not routing.
pub async fn serve(
    addr: std::net::SocketAddr,
    tracker: Arc<LagTracker>,
    max_lag_ledgers: u32,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    log::info!("health endpoint listening on http://{addr}/health");
    loop {
        let (mut stream, _) = listener.accept().await?;
        let health = tracker.health(max_lag_ledgers);
        tokio::spawn(async move {
            // Drain whatever request head arrived; the response is the same
            // regardless, and an unread request can wedge naive clients.
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let body = health.to_json();
            let status = if health.healthy {
                "200 OK"
            } else {
                "503 Service Unavailable"
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stalled_loop_shows_growing_lag_and_flips_unhealthy() {
        // The issue's scenario: ingestion stops while the chain advances.
        let t = LagTracker::new();
        t.observe_latest(1_000);
        t.observe_ingested(1_000);
        assert!(t.health(120).healthy, "caught up must be healthy");
        assert_eq!(t.health(120).lag_ledgers, 0);

        // The chain moves on; the stalled loop ingests nothing further.
        for tip in [1_050, 1_100, 1_119] {
            t.observe_latest(tip);
            let h = t.health(120);
            assert_eq!(h.lag_ledgers, tip - 1_000, "lag grows with the tip");
            assert!(h.healthy, "still inside the threshold");
        }

        // Past the configured threshold the verdict flips.
        t.observe_latest(1_121);
        let h = t.health(120);
        assert_eq!(h.lag_ledgers, 121);
        assert!(!h.healthy, "past the threshold must be unhealthy");

        // Ingestion resumes: verdict recovers.
        t.observe_ingested(1_121);
        assert!(t.health(120).healthy);
    }

    #[test]
    fn before_any_successful_cycle_the_verdict_is_unhealthy() {
        // Zero observations means "unknown", and a probe must not read a
        // freshly-wedged service (never completed one cycle) as healthy.
        let t = LagTracker::new();
        assert!(!t.health(120).healthy);
    }

    #[test]
    fn counters_never_move_backwards() {
        // An RPC answering from a lagging replica must not shrink the tip and
        // fake a recovery.
        let t = LagTracker::new();
        t.observe_latest(500);
        t.observe_latest(400);
        assert_eq!(t.health(10).latest_ledger, 500);
    }

    #[test]
    fn health_json_carries_every_field() {
        let t = LagTracker::new();
        t.observe_latest(200);
        t.observe_ingested(150);
        let json = t.health(60).to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert_eq!(parsed["healthy"], true);
        assert_eq!(parsed["lag_ledgers"], 50);
        assert_eq!(parsed["latest_ledger"], 200);
        assert_eq!(parsed["last_ingested_ledger"], 150);
        assert_eq!(parsed["max_lag_ledgers"], 60);
    }
}
