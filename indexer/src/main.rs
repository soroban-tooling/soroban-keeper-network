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
