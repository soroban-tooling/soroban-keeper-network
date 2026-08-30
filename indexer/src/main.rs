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

mod config;
mod rpc;

use config::Config;
use rpc::{RpcClient, Start};
use sqlx::postgres::PgPoolOptions;
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

    run_loop(&config, &rpc).await;
}

/// The single ingest loop from the design: backfill and steady state are the
/// same code path. In the scaffold the "apply" step is a log line.
async fn run_loop(config: &Config, rpc: &RpcClient) {
    let mut cursor: Option<String> = None;
    let mut shutdown = std::pin::pin!(tokio::signal::ctrl_c());

    loop {
        let start = match &cursor {
            // First request of the run: a ledger. Every later request: the
            // returned cursor — the RPC treats the two as mutually exclusive.
            None => Start::Ledger(config.start_ledger),
            Some(c) => Start::Cursor(c),
        };

        match rpc.get_events(&config.contract_id, start, PAGE_LIMIT).await {
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
                if let Some(next) = page.cursor {
                    cursor = Some(next);
                }
                if caught_up {
                    log::debug!("caught up through ledger {}", page.latest_ledger);
                } else {
                    // More pages waiting: keep paging before sleeping.
                    continue;
                }
            }
            Err(e) => {
                log::error!("getEvents failed: {e} — retrying next round");
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(config.poll_interval_ms)) => {}
            _ = &mut shutdown => {
                log::info!("shutdown requested, exiting");
                return;
            }
        }
    }
}
