//! Indexer entry point.
//!
//! Startup order matters: configuration is validated before anything connects,
//! so a misconfigured deployment fails immediately with the full list of
//! problems rather than part-way through its first poll.

use anyhow::{Context, Result};
use keeper_indexer::rpc::HttpClient;
use keeper_indexer::service::shutdown_signal;
use keeper_indexer::{Config, Service, Store};
use tracing_subscriber::EnvFilter;

/// Reduces a URL to the minimum needed to identify the endpoint in logs.
///
/// RPC provider URLs commonly carry an API key in the user info, path or
/// query string. Logging the raw value would leak that key, so keep only the
/// scheme, host and port. Unparseable values are replaced with a placeholder
/// rather than echoed back.
fn redact_url(url: &str) -> String {
    match url.parse::<reqwest::Url>() {
        Ok(parsed) => match (parsed.scheme(), parsed.host()) {
            (scheme, Some(host)) => match parsed.port() {
                Some(port) => format!("{scheme}://{host}:{port}"),
                None => format!("{scheme}://{host}"),
            },
            _ => "<unparseable-url>".to_string(),
        },
        Err(_) => "<unparseable-url>".to_string(),
    }
}

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
        rpc_url = %redact_url(&config.rpc_url),
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
    tracing::info!(address = %listener.local_addr()?, "serving the /v1 API");

    // A returned error is a failed ingestion or HTTP task. Exiting non-zero
    // (rather than leaving the other half running) is what lets a process
    // supervisor notice and restart; ingestion resumes from its checkpoint.
    service
        .run(listener, shutdown_signal())
        .await
        .context("keeper indexer stopped")?;
    tracing::info!("shut down cleanly");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::redact_url;

    #[test]
    fn redacts_credentials_path_and_query() {
        let url = "https://user:secret@rpc.example.com/api/v1?key=supersecret";
        assert_eq!(redact_url(url), "https://rpc.example.com");
    }

    #[test]
    fn keeps_an_explicit_port() {
        assert_eq!(
            redact_url("http://localhost:8000/foo"),
            "http://localhost:8000"
        );
    }

    #[test]
    fn brackets_an_ipv6_host() {
        assert_eq!(redact_url("http://[::1]:8000/path"), "http://[::1]:8000");
    }

    #[test]
    fn never_echoes_an_unparseable_value() {
        assert_eq!(redact_url("not a url"), "<unparseable-url>");
        assert_eq!(
            redact_url("postgres://u:p@db:5432/name"),
            "postgres://db:5432"
        );
    }
}
