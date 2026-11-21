//! Indexer entry point.
//!
//! Startup order matters: configuration is validated before anything connects,
//! so a misconfigured deployment fails immediately with the full list of
//! problems rather than part-way through its first poll.

use anyhow::{Context, Result};
use keeper_indexer::rpc::HttpClient;
use keeper_indexer::service::shutdown_signal;
use keeper_indexer::{Config, Service, Store};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{SpanExporter, WithExportConfig};
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::Subscriber;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// Build the optional OTLP layer and its provider together. The provider must
/// be kept alive until shutdown so the batch processor can flush. The layer is
/// generic over the subscriber it will be attached to, which keeps it valid
/// when composed after the formatting layer.
fn build_otel_layer<S>(
    endpoint: Option<&str>,
) -> Result<(
    Option<OpenTelemetryLayer<S, opentelemetry_sdk::trace::SdkTracer>>,
    Option<SdkTracerProvider>,
)>
where
    S: Subscriber + for<'span> LookupSpan<'span> + 'static,
{
    let Some(endpoint) = endpoint else {
        return Ok((None, None));
    };
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        anyhow::bail!("INDEXER_OTLP_ENDPOINT must be an http(s) URL, got {endpoint:?}");
    }

    let exporter = SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .build()
        .context("building the OTLP span exporter")?;
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .build();
    let tracer = provider.tracer("keeper-indexer");
    Ok((Some(OpenTelemetryLayer::new(tracer)), Some(provider)))
}

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

    let filter = EnvFilter::try_from_env("INDEXER_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = tracing_subscriber::fmt::layer().with_filter(filter.clone());
    let (otel_layer, tracer_provider) = build_otel_layer(config.otlp_endpoint.as_deref())
        .context("configuring OTLP trace export")?;
    // `Option<L>` is itself a `Layer`, so the disabled path installs exactly
    // one formatting layer and creates no exporter or batch worker.
    let otel_layer = otel_layer.map(|layer| layer.with_filter(filter));
    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    tracing::info!(
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
    tracing::info!(address = %listener.local_addr()?, "serving the /v1 API");

    // A returned error is a failed ingestion or HTTP task. Exiting non-zero
    // (rather than leaving the other half running) is what lets a process
    // supervisor notice and restart; ingestion resumes from its checkpoint.
    service
        .run(listener, shutdown_signal())
        .await
        .context("keeper indexer stopped")?;
    tracing::info!("shut down cleanly");

    if let Some(provider) = tracer_provider {
        let _ = provider.shutdown();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::build_otel_layer;
    use tracing_subscriber::Registry;

    #[test]
    fn no_endpoint_builds_no_layer_and_no_exporter() {
        let (layer, provider) = build_otel_layer::<Registry>(None).expect("no endpoint is valid");
        assert!(
            layer.is_none(),
            "a disabled exporter must not install a layer"
        );
        assert!(
            provider.is_none(),
            "a disabled exporter must not spawn a worker"
        );
    }

    #[test]
    fn a_non_http_endpoint_is_rejected() {
        match build_otel_layer::<Registry>(Some("collector.example.org:4318")) {
            Ok(_) => panic!("an endpoint without a scheme must be rejected"),
            Err(err) => assert!(
                err.to_string().contains("INDEXER_OTLP_ENDPOINT"),
                "the error should name the setting: {err}"
            ),
        }
    }
}
