//! Indexer entry point.
//!
//! Startup order matters: configuration is validated before anything connects,
//! so a misconfigured deployment fails immediately with the full list of
//! problems rather than part-way through its first poll.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use anyhow::{Context, Result};
use keeper_indexer::rpc::HttpClient;
use keeper_indexer::{Backfiller, Config, Ingestor, Store};
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
    // Kept for the API/WebSocket wiring (a later commit): `Ingestor` is
    // `Clone` over a shared broadcast channel, so the backfiller below gets
    // its own handle rather than the only one.
    let ingestor = Ingestor::new(store);

    let source = HttpClient::new(&config.rpc_url);
    let backfiller = Backfiller::new(
        source,
        ingestor.clone(),
        config.contract_id.clone(),
        config.backfill_page_size,
    );

    tracing::info!("store ready; ingesting");

    backfiller
        .run_until_shutdown(
            config.start_ledger,
            Duration::from_secs(config.poll_interval_secs),
            Duration::from_secs(config.shutdown_drain_secs),
            shutdown_signal(),
        )
        .await
        .context("ingestion loop failed")?;

    tracing::info!("shut down cleanly");

    Ok(())
}

/// Resolves on SIGINT (ctrl-c; every platform) or SIGTERM (unix only -- what
/// a container orchestrator sends on a normal stop or restart).
fn shutdown_signal() -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async {
        let ctrl_c = async {
            let _ = tokio::signal::ctrl_c().await;
        };

        #[cfg(unix)]
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut sigterm) => {
                    sigterm.recv().await;
                }
                Err(err) => {
                    // Fall back to SIGINT-only rather than crashing the
                    // process over a handler that could not be installed.
                    tracing::warn!(%err, "could not install a SIGTERM handler");
                    std::future::pending::<()>().await;
                }
            }
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<()>();

        tokio::select! {
            () = ctrl_c => tracing::info!("received SIGINT"),
            () = terminate => tracing::info!("received SIGTERM"),
        }
    })
}
