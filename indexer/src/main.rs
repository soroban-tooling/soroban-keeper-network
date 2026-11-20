//! Indexer entry point.
//!
//! Startup order matters: configuration is validated before anything connects,
//! so a misconfigured deployment fails immediately with the full list of
//! problems rather than part-way through its first poll.

use anyhow::{Context, Result};
use keeper_indexer::rpc::HttpClient;
use keeper_indexer::service::shutdown_signal;
use keeper_indexer::{Config, LogFormat, Service, Store};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            // Every problem at once, so one restart is enough to fix them all.
            eprintln!("{err}");
            std::process::exit(2);
        }
    };

    // The filter is identical in both modes. Only the renderer changes, so
    // switching formats cannot change what is logged or at which level.
    let filter = EnvFilter::try_from_env("INDEXER_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let registry = tracing_subscriber::registry().with(filter);
    match config.log_format {
        LogFormat::Human => registry.with(tracing_subscriber::fmt::layer()).init(),
        LogFormat::Json => registry
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    // Put `message` and all structured fields at the root:
                    // log pipelines index one flat object per line.
                    .flatten_event(true)
                    .with_current_span(false)
                    .with_span_list(false)
                    .with_timer(tracing_subscriber::fmt::time::UtcTime::rfc_3339()),
            )
            .init(),
    }

    tracing::info!(
        component = "indexer",
        rpc_url = %config.rpc_url,
        contract_id = %config.contract_id,
        start_ledger = config.start_ledger,
        "starting keeper indexer"
    );

    let source = HttpClient::new(&config.rpc_url);
    // A wrong INDEXER_RPC_URL should stop the boot, not surface as a failed
    // poll a few seconds in.
    source
        .get_health()
        .await
        .context("checking the Soroban RPC endpoint")?;

    let store = Store::connect(&config.database_url)
        .await
        .context("opening the event store")?;

    let service = Service::new(config, source, store);
    let listener = service.bind().await?;
    tracing::info!(component = "indexer", address = %listener.local_addr()?, "serving the /v1 API and /metrics");

    // A returned error is a failed ingestion or HTTP task. Exiting non-zero
    // (rather than leaving the other half running) is what lets a process
    // supervisor notice and restart; ingestion resumes from its checkpoint.
    service
        .run(listener, shutdown_signal())
        .await
        .context("keeper indexer stopped")?;
    tracing::info!(component = "indexer", "shut down cleanly");

    Ok(())
}
