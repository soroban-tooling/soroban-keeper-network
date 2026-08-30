//! Indexer scaffold (issue 0219): a runnable, empty service proving the
//! plumbing from docs/INDEXER_DESIGN.md before any event-specific logic —
//! this epic's equivalent of the fuzz harness setup (0051).
//!
//! What it does: validate configuration (fail loudly and specifically, per
//! the keeper bot's requireEnv discipline), connect to Postgres and run the
//! (currently empty) migration set, health-check the RPC, then poll
//! `getEvents` for the configured contract with full pagination and LOG each
//! raw event observed — no parsing, no storing. The schema arrives with
//! 0220–0222; per-event ingestion with 0230's idempotency gate on top.

use keeper_indexer::config::Config;
use keeper_indexer::health::{serve, LagTracker};
use keeper_indexer::rpc::{RpcClient, Start};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use std::time::Duration;

/// Page size for getEvents. The RPC caps pages; a short page means caught up.
const PAGE_LIMIT: u32 = 100;

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            // The requireEnv contract: name, value (unless secret), reason —
            // then refuse to boot. No partial startup, no crash-on-first-use.
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    // Database first: a service that cannot store has no business ingesting.
    // The migration directory ships empty in the scaffold — running the
    // migrator now means 0220's first real migration needs zero new wiring.
    let pool = match PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            // sqlx errors do not echo the connection string (which carries a
            // password); print only the failure kind.
            eprintln!("Invalid DATABASE_URL — could not connect: {e}");
            std::process::exit(1);
        }
    };
    // Resolved from the crate's own manifest dir, not the CWD, so the service
    // runs identically from the workspace root, the crate dir, or a wrapper.
    let migrations = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
    match sqlx::migrate::Migrator::new(std::path::Path::new(migrations)).await {
        Ok(migrator) => {
            if let Err(e) = migrator.run(&pool).await {
                eprintln!("migrations failed: {e}");
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("could not load migrations directory: {e}");
            std::process::exit(1);
        }
    }
    log::info!("database connected, migrations current");

    let rpc = RpcClient::new(&config.rpc_url);
    if let Err(e) = rpc.get_health().await {
        eprintln!("Invalid INDEXER_RPC_URL — endpoint failed health check: {e}");
        std::process::exit(1);
    }
    log::info!(
        "rpc healthy; observing contract {} from ledger {}",
        config.contract_id,
        config.start_ledger
    );

    let tracker = LagTracker::new();
    {
        let tracker = Arc::clone(&tracker);
        let addr = config.health_addr;
        let max_lag = config.max_lag_ledgers;
        tokio::spawn(async move {
            if let Err(e) = serve(addr, tracker, max_lag).await {
                // The service can ingest without its probe, but an operator
                // relying on /health must hear that it is gone.
                log::error!("health endpoint failed: {e}");
            }
        });
    }

    run_loop(&config, &rpc, &tracker).await;
}

/// The single ingest loop from the design: backfill and steady state are the
/// same code path. In the scaffold the "apply" step is a log line.
async fn run_loop(config: &Config, rpc: &RpcClient, tracker: &LagTracker) {
    let mut cursor: Option<String> = None;
    // Fallback resume point for RPC generations whose responses omit the
    // paging cursor: advanced past every exchange, so the loop can never
    // re-request the same window round after round (the keeper bot's 0032
    // bug, which this loop exists not to inherit).
    let mut next_start = config.start_ledger;
    let mut shutdown = std::pin::pin!(tokio::signal::ctrl_c());

    loop {
        let (start, via_cursor, started_from) = match &cursor {
            // First request of the run: a ledger. Every later request: the
            // returned cursor — the RPC treats the two as mutually exclusive.
            None => (Start::Ledger(next_start), false, next_start),
            Some(c) => (Start::Cursor(c), true, 0),
        };

        let sleep_ms = match rpc.get_events(&config.contract_id, start, PAGE_LIMIT).await {
            Ok(page) => {
                for ev in &page.events {
                    // Observation only — the scaffold's whole job. Topics and
                    // value stay XDR base64; decoding is 0220 onward.
                    log::info!(
                        "event id={} ledger={} contract={} topics={:?} value={}",
                        ev.id,
                        ev.ledger,
                        ev.contract_id,
                        ev.topic,
                        ev.value
                    );
                }
                let caught_up = page.events.len() < PAGE_LIMIT as usize;
                // Lag bookkeeping, updated on every ingestion cycle. The tip
                // comes from this exchange. "Fully ingested" is claimed
                // conservatively: a page that CARRIED events proves we are
                // reading real history (mid-backfill, the last event on the
                // page; caught up, the tip), and an EMPTY page counts only
                // when it was cursor-reached — continuity from a previous
                // page proves the silence is genuine quiet. An empty page
                // from a bare start ledger proves nothing: past the RPC's
                // retention window getEvents returns exactly this error-free
                // emptiness, and marking the tip ingested there would report
                // a truncated backfill as lag-0 healthy.
                tracker.observe_latest(page.latest_ledger);
                match page.events.last() {
                    Some(last) if !caught_up => tracker.observe_ingested(last.ledger),
                    Some(_) => tracker.observe_ingested(page.latest_ledger),
                    None if via_cursor => tracker.observe_ingested(page.latest_ledger),
                    None => log::warn!(
                        "empty page from bare start ledger {started_from} (tip {}) — either                          nothing has ever happened here, or the start is outside the RPC's                          retention window; not marking these ledgers ingested",
                        page.latest_ledger
                    ),
                }
                if let Some(next) = page.cursor {
                    cursor = Some(next);
                } else if let Some(last) = page.events.last() {
                    cursor = Some(last.id.clone());
                } else {
                    next_start = next_start.max(page.latest_ledger.saturating_add(1));
                }
                if caught_up {
                    log::debug!("caught up through ledger {}", page.latest_ledger);
                    config.poll_interval_ms
                } else {
                    // More pages waiting: no sleep, but still an await point
                    // below — a multi-hour backfill must not be un-killable.
                    0
                }
            }
            Err(e) => {
                log::error!("getEvents failed: {e} — retrying next round");
                // Keep the tip honest even while the event path is down: a
                // stalled loop must show GROWING lag, not a frozen one. Best
                // effort — if the whole endpoint is out this fails too, and
                // the tip simply stops advancing at its last known value.
                if let Ok(tip) = rpc.get_latest_ledger().await {
                    tracker.observe_latest(tip);
                }
                config.poll_interval_ms
            }
        };

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
            _ = &mut shutdown => {
                log::info!("shutdown requested, exiting");
                return;
            }
        }
    }
}
