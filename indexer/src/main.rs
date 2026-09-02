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
    // Fallback resume point for RPC generations whose responses omit the
    // paging cursor: advanced past every exchange, so the loop can never
    // re-request the same window round after round (the keeper bot's 0032
    // bug, which this loop exists not to inherit).
    let mut next_start = config.start_ledger;
    let mut shutdown = std::pin::pin!(tokio::signal::ctrl_c());

    loop {
        let start = match &cursor {
            // First request of the run: a ledger. Every later request: the
            // returned cursor — the RPC treats the two as mutually exclusive.
            None => Start::Ledger(next_start),
            Some(c) => Start::Cursor(c),
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
                // Never lose our place. Prefer the RPC's cursor; without
                // one, the last event's id doubles as a paging token; an
                // empty cursorless page still advances the ledger fallback
                // past everything this exchange covered — otherwise a full
                // page would be re-requested forever and an empty one
                // rescanned every round.
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
//! Indexer entry point.
//!
//! Startup order matters: configuration is validated before anything connects,
//! so a misconfigured deployment fails immediately with the full list of
//! problems rather than part-way through its first poll.

use anyhow::{Context, Result};
use keeper_indexer::{Config, Ingestor, Store};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("INDEXER_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            // Every problem at once, so one restart is enough to fix them all.
            eprintln!("{err}");
            std::process::exit(2);
        }
    };

    tracing::info!(
        rpc_url = %config.rpc_url,
        contract_id = %config.contract_id,
        start_ledger = config.start_ledger,
        "starting keeper indexer"
    );

    let store = Store::connect(&config.database_url)
        .await
        .context("opening the event store")?;
    let ingestor = Ingestor::new(store);

    tracing::info!("store ready; ingestion and API wiring land with the service loop");

    // Keep the process alive until interrupted; the ingest loop and API server
    // are wired in by the backfill and API commits.
    let _ = ingestor;
    tokio::signal::ctrl_c()
        .await
        .context("waiting for shutdown signal")?;
    tracing::info!("shutting down");

    Ok(())
}
