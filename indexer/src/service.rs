//! The running indexer: ingestion and the HTTP API under one lifecycle.
//!
//! Two jobs run side by side, the [`Backfiller`] walking the chain and the
//! `/v1` router serving what it stores. They are supervised together, because
//! a process that keeps serving a database nothing is feeding (or keeps
//! ingesting with nobody able to read it) looks healthy from the outside while
//! being broken.
//!
//! The rules:
//!
//! - **Either job ending ends the service.** An error from ingestion or from
//!   the HTTP server is returned from [`Service::run`], and `main` exits
//!   non-zero so the process supervisor restarts it. Neither job is ever
//!   expected to finish on its own, so a clean return from one is also
//!   treated as a failure.
//! - **A shutdown request drains, it does not abort.** On SIGINT or SIGTERM
//!   ingestion finishes and checkpoints the pass it is on (see
//!   [`Backfiller::run_until_shutdown`]), then stops; the HTTP server stops
//!   accepting connections and lets in-flight requests finish. A restart
//!   resumes from the checkpoint.
//! - **Draining is bounded.** Ingestion is bounded by
//!   `INDEXER_SHUTDOWN_DRAIN_SECS`. Open WebSocket subscriptions would
//!   otherwise keep the server up indefinitely, so the HTTP side gets the same
//!   window; after it, whatever is still running is dropped. Ingestion is
//!   idempotent, so the worst case is re-reading one page on the next start.

use std::future::{Future, IntoFuture};
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::api::{self, ApiState};
use crate::backfill::Backfiller;
use crate::cache::AggregateCaches;
use crate::config::Config;
use crate::ingest::Ingestor;
use crate::rpc::EventSource;
use crate::store::Store;

/// The indexer's long-running half: everything `main` starts after
/// configuration is validated and the store is open.
pub struct Service<S: EventSource> {
    config: Config,
    source: S,
    ingestor: Ingestor,
}

impl<S: EventSource> Service<S> {
    /// Build a service that reads events from `source` into `store`.
    pub fn new(config: Config, source: S, store: Store) -> Self {
        Self {
            config,
            source,
            ingestor: Ingestor::new(store),
        }
    }

    /// Bind the configured API address.
    ///
    /// Separate from [`run`](Self::run) so `main` can fail on a taken port
    /// before ingestion starts, and so tests can bind port 0 and learn the
    /// address.
    pub async fn bind(&self) -> Result<TcpListener> {
        TcpListener::bind(&self.config.bind_address)
            .await
            .with_context(|| format!("binding the API to {}", self.config.bind_address))
    }

    /// Run ingestion and the API until `shutdown` resolves or either fails.
    ///
    /// Returns `Ok(())` only for a requested shutdown that drained cleanly.
    pub async fn run(
        self,
        listener: TcpListener,
        shutdown: impl Future<Output = ()>,
    ) -> Result<()> {
        let Self {
            config,
            source,
            ingestor,
        } = self;
        let drain_timeout = Duration::from_secs(config.shutdown_drain_secs);

        let (stop_tx, stop_rx) = watch::channel(false);

        let backfiller = Backfiller::new(
            source,
            ingestor.clone(),
            config.contract_id.clone(),
            config.backfill_page_size,
        );
        let progress = backfiller.progress();
        let mut ingestion_stop = stop_rx.clone();
        let ingestion = backfiller.run_until_shutdown(
            config.start_ledger,
            Duration::from_secs(config.poll_interval_secs),
            drain_timeout,
            Box::pin(async move {
                let _ = ingestion_stop.wait_for(|stopped| *stopped).await;
            }),
        );

        let app = api::router(
            ApiState::new(
                ingestor,
                AggregateCaches::from_secs(config.cache_ttl_secs),
                progress,
                config.max_healthy_lag_ledgers,
            ),
            config.rate_limit_per_second,
            config.rate_limit_burst,
        );
        let mut http_stop = stop_rx;
        let http = axum::serve(
            listener,
            // Connect info is what lets the rate limiter key on client IP
            // when a request carries no API key.
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = http_stop.wait_for(|stopped| *stopped).await;
        })
        .into_future();

        tokio::pin!(ingestion);
        tokio::pin!(http);
        tokio::pin!(shutdown);

        // Whichever job ends first decides the outcome; the other is then
        // asked to stop and given the drain window.
        let (outcome, ingestion_done, http_done) = tokio::select! {
            () = &mut shutdown => {
                tracing::info!("shutdown requested; draining");
                (Ok(()), false, false)
            }
            result = &mut ingestion => {
                let err = match result {
                    Ok(()) => anyhow!("ingestion stopped unexpectedly"),
                    Err(err) => err.context("ingestion failed"),
                };
                (Err(err), true, false)
            }
            result = &mut http => {
                let err = match result {
                    Ok(()) => anyhow!("the API server stopped unexpectedly"),
                    Err(err) => anyhow::Error::new(err).context("the API server failed"),
                };
                (Err(err), false, true)
            }
        };

        let _ = stop_tx.send(true);

        let drained = tokio::time::timeout(drain_timeout, async {
            let ingestion_result = if ingestion_done {
                Ok(())
            } else {
                (&mut ingestion)
                    .await
                    .context("ingestion failed while draining")
            };
            let http_result = if http_done {
                Ok(())
            } else {
                (&mut http)
                    .await
                    .map_err(anyhow::Error::new)
                    .context("the API server failed while draining")
            };
            (ingestion_result, http_result)
        })
        .await;

        let mut outcome = outcome;
        match drained {
            Ok((ingestion_result, http_result)) => {
                for result in [ingestion_result, http_result] {
                    if let Err(err) = result {
                        // Keep the first failure as the reported one; the
                        // rest still reach the log.
                        if outcome.is_ok() {
                            outcome = Err(err);
                        } else {
                            tracing::error!(error = %format!("{err:#}"), "also failed during shutdown");
                        }
                    }
                }
            }
            Err(_) => {
                tracing::warn!(
                    timeout_secs = drain_timeout.as_secs_f64(),
                    "drain timed out; dropping what is still running"
                );
            }
        }

        outcome
    }
}

/// Resolves on SIGINT (Ctrl-C) or, on Unix, SIGTERM -- the signal a container
/// runtime or systemd sends first.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            // Could not install the handler: never resolve rather than
            // shutting down the instant we start.
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    () = ctrl_c => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => ctrl_c.await,
        }
    }

    #[cfg(not(unix))]
    ctrl_c.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::fixture::FixtureSource;
    use crate::rpc::{RawEvent, RawValue};

    fn config() -> Config {
        Config {
            rpc_url: "http://unused.invalid".into(),
            contract_id: "CCONTRACT".into(),
            database_url: "sqlite::memory:".into(),
            start_ledger: 1,
            bind_address: "127.0.0.1:0".into(),
            poll_interval_secs: 1,
            backfill_page_size: 100,
            cache_ttl_secs: 0,
            rate_limit_per_second: 1_000,
            rate_limit_burst: 1_000,
            shutdown_drain_secs: 5,
            max_healthy_lag_ledgers: 60,
        }
    }

    fn registered(ledger: u32, task_id: u64) -> RawEvent {
        RawEvent {
            ledger,
            ledger_close_time: i64::from(ledger) * 5,
            tx_hash: format!("tx{task_id}"),
            event_index: 0,
            topics: vec!["reg".into(), "task".into()],
            values: vec![
                RawValue::U64(task_id),
                RawValue::Address("GOWNER".into()),
                RawValue::I128(500),
                RawValue::U64(9_000),
            ],
        }
    }

    async fn start(source: FixtureSource) -> (Service<FixtureSource>, TcpListener, String, Store) {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let service = Service::new(config(), source, store.clone());
        let listener = service.bind().await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        (service, listener, base, store)
    }

    async fn get(url: &str) -> reqwest::Response {
        reqwest::get(url).await.expect("request")
    }

    #[tokio::test]
    async fn ingests_and_serves_then_drains_on_shutdown() {
        let source = FixtureSource::new(vec![registered(5, 1)], 10);
        let (service, listener, base, store) = start(source).await;
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let run = tokio::spawn(async move {
            service
                .run(listener, async {
                    let _ = stopped.await;
                })
                .await
        });

        // Wait for the walk to finish, as an operator would via /v1/health.
        let health = loop {
            let body: serde_json::Value = get(&format!("{base}/v1/health"))
                .await
                .json()
                .await
                .expect("json");
            if body["backfill_complete"] == true {
                break body;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(health["last_ingested_ledger"], 10);

        let task = get(&format!("{base}/v1/tasks/1")).await;
        assert_eq!(task.status(), 200);

        stop.send(()).expect("service still running");
        run.await.expect("join").expect("clean shutdown");

        // The checkpoint survived the shutdown, so a restart resumes from it.
        let checkpoint = store.checkpoint().await.expect("checkpoint").expect("some");
        assert_eq!(checkpoint.last_ledger, 10);
        assert!(checkpoint.backfill_complete);
    }

    #[tokio::test]
    async fn an_ingestion_failure_ends_the_service_with_that_error() {
        let source = FixtureSource::new(vec![registered(5, 1)], 10);
        source.fail_once_at(1);
        let (service, listener, base, _store) = start(source).await;

        let err = service
            .run(listener, std::future::pending())
            .await
            .expect_err("a failed ingestion must not leave the API running");

        assert!(
            format!("{err:#}").contains("ingestion failed"),
            "unexpected error: {err:#}"
        );
        // And the listener is gone with it: no half-running process.
        assert!(reqwest::get(format!("{base}/v1/health")).await.is_err());
    }
}
