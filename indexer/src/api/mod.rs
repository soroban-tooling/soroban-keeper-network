//! The HTTP API over ingested data.
//!
//! Response types live in [`types`] and are defined independently of the
//! database schema. A future storage migration therefore changes the store and
//! the mapping into these types, without forcing every API consumer to update
//! in lockstep.
//!
//! Every route is served under `/v1`. Versioning from the first release means
//! a dashboard built against v1 keeps working when v2 appears alongside it,
//! rather than the prefix being retrofitted after something has already broken.

pub mod auth;
pub mod rate_limit;
pub mod request_id;
pub mod rest;
pub mod types;
pub mod websocket;

use std::sync::Arc;
use std::time::Instant;

use axum::{Extension, Router};
use axum::extract::{MatchedPath, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use utoipa::OpenApi;

use crate::cache::AggregateCaches;
use crate::ingest::Ingestor;
use crate::metrics::{self, Metrics};
use crate::progress::IngestionProgress;
use rate_limit::RateLimiter;

/// Route template stashed by an inner middleware once the router has matched.
#[derive(Clone)]
struct RouteTemplate(String);

/// Shared state every handler reads from.
#[derive(Clone)]
pub struct ApiState {
    pub ingestor: Ingestor,
    /// Short-TTL caches in front of the expensive aggregate folds. Cloned with
    /// the state, so every handler shares one set of entries.
    pub caches: AggregateCaches,
    /// Shared ingestion-progress state the backfiller writes and /health
    /// reads the lag off (issue #359). `Backfiller::progress()` hands out
    /// the matching handle.
    pub progress: IngestionProgress,
    /// Lag, in ledgers, past which /health reports unhealthy (issue #359).
    pub max_healthy_lag_ledgers: u32,
    /// Store and verifier for API keys.
    pub api_keys: Arc<auth::ApiKeys>,
    /// Shared counters for `/metrics` and the request middleware.
    pub metrics: Arc<Metrics>,
}

impl ApiState {
    pub fn new(
        ingestor: Ingestor,
        caches: AggregateCaches,
        progress: IngestionProgress,
        max_healthy_lag_ledgers: u32,
    ) -> Self {
        let api_keys = Arc::new(auth::ApiKeys::new(ingestor.store().pool().clone()));
        Self::with_parts(
            ingestor,
            caches,
            progress,
            max_healthy_lag_ledgers,
            api_keys,
            Arc::new(Metrics::new()),
        )
    }

    pub fn with_api_keys(
        ingestor: Ingestor,
        caches: AggregateCaches,
        progress: IngestionProgress,
        max_healthy_lag_ledgers: u32,
        api_keys: Arc<auth::ApiKeys>,
    ) -> Self {
        Self::with_parts(
            ingestor,
            caches,
            progress,
            max_healthy_lag_ledgers,
            api_keys,
            Arc::new(Metrics::new()),
        )
    }

    /// Build state with a shared metrics registry, so an ingestor and the API
    /// report into the same scrape.
    pub fn with_metrics(
        ingestor: Ingestor,
        caches: AggregateCaches,
        progress: IngestionProgress,
        max_healthy_lag_ledgers: u32,
        metrics: Arc<Metrics>,
    ) -> Self {
        let api_keys = Arc::new(auth::ApiKeys::new(ingestor.store().pool().clone()));
        Self::with_parts(
            ingestor,
            caches,
            progress,
            max_healthy_lag_ledgers,
            api_keys,
            metrics,
        )
    }

    fn with_parts(
        ingestor: Ingestor,
        caches: AggregateCaches,
        progress: IngestionProgress,
        max_healthy_lag_ledgers: u32,
        api_keys: Arc<auth::ApiKeys>,
        metrics: Arc<Metrics>,
    ) -> Self {
        Self {
            ingestor,
            caches,
            progress,
            max_healthy_lag_ledgers,
            api_keys,
            metrics,
        }
    }
}

/// The OpenAPI document, derived from the same handler and response types the
/// server actually uses.
///
/// Generating it here rather than maintaining a separate YAML by hand means
/// the document cannot describe a shape the handlers no longer return.
#[derive(OpenApi)]
#[openapi(
    servers((url = "/v1", description = "Version 1 of the API")),
    info(
        title = "Keeper Registry Indexer API",
        version = "1.0.0",
        description = "Read-only access to indexed keeper registry events and the state derived from them."
    ),
    paths(
        rest::health,
        rest::get_task,
        rest::tasks_by_owner,
        rest::tasks_by_keeper,
        rest::admin_config,
        rest::open_tasks_by_feed,
        rest::event_feed,
        rest::keeper_leaderboard,
    ),
    components(schemas(
        crate::events::EventType,
        crate::events::EventPayload,
        crate::events::IndexedEvent,
        crate::state::TaskState,
        crate::state::TaskStatus,
        crate::state::KeeperSummary,
        crate::state::AdminConfig,
        crate::queries::leaderboard::Leaderboard,
        crate::queries::leaderboard::LeaderboardEntry,
        crate::queries::leaderboard::RankBy,
        types::ApiError,
        types::EventFeedResponse,
        types::HealthResponse,
        types::TaskDetail,
        types::TaskListResponse,
        types::FeedTasksResponse,
        types::TaskByFeed,
    )),
    tags((name = "indexer", description = "Indexed registry data"))
)]
pub struct ApiDoc;

/// Prometheus text-format metrics for ingestion, the API and the caches.
///
/// Served on the API listener so an operator needs only one exposed port.
/// The body contains operational counts and bounded label values, never a
/// secret, a full URL or a caller-supplied path.
pub async fn metrics_handler(State(state): State<ApiState>) -> impl IntoResponse {
    let body = state.metrics.render(&state.progress, &state.caches);
    (
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
}

/// Count every response, including ones rejected before reaching a handler.
///
/// The route comes from the router's `MatchedPath` where available, so a task
/// id cannot multiply the series. The fallback normalises raw paths for 404s
/// and WebSocket upgrades, which never produce a matched template.
async fn track_requests(
    State(metrics): State<Arc<Metrics>>,
    request: Request,
    next: Next,
) -> Response {
    let route = request
        .extensions()
        .get::<RouteTemplate>()
        .map(|template| template.0.clone())
        .or_else(|| {
            request
                .extensions()
                .get::<MatchedPath>()
                .map(|matched| matched.as_str().to_string())
        })
        .unwrap_or_else(|| metrics::normalize_route(request.uri().path()));
    let started = Instant::now();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    metrics.record_request(&route, status, started.elapsed());
    if status == StatusCode::TOO_MANY_REQUESTS.as_u16() {
        metrics.record_rate_limit_rejection();
    }
    response
}

/// Stash the matched template while routing still has it.
///
/// `Router::layer` wraps the router, so an outer metrics middleware runs before
/// `MatchedPath` is inserted. This inner layer sees it and copies it into an
/// extension the outer layer can read after the response comes back.
async fn stash_matched_route(mut request: Request, next: Next) -> Response {
    let template = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_string());
    if let Some(template) = template {
        request.extensions_mut().insert(RouteTemplate(template));
    }
    next.run(request).await
}

/// Build the API router with a pre-configured rate limiter.
pub fn router_with_limiter(state: ApiState, limiter: Arc<RateLimiter>) -> Router {
    let metrics = state.metrics.clone();
    Router::new()
        .nest("/v1", rest::routes())
        .route("/v1/stream", get(websocket::subscribe))
        .route("/metrics", get(metrics_handler))
        .with_state(state)
        .layer(Extension(Arc::new(websocket::WebSocketLimits::default())))
        .layer(axum::middleware::from_fn_with_state(
            limiter,
            rate_limit::enforce,
        ))
        .layer(axum::middleware::from_fn(stash_matched_route))
        // Outermost layer: it sees every response, including rate-limit
        // rejections, and the route template stashed by the inner layer.
        .layer(axum::middleware::from_fn_with_state(
            metrics,
            track_requests,
        ))
        // Layers run from the inside out, so this one wraps the rate limiter:
        // even a rejected request gets a correlation id and a span.
        .layer(axum::middleware::from_fn(request_id::trace_requests))
}

/// Build the API router, rate limited per client (by `X-API-Key`, else IP)
/// on both REST routes and the WebSocket upgrade.
pub fn router(state: ApiState, rate_limit_per_second: u32, rate_limit_burst: u32) -> Router {
    let limiter = Arc::new(RateLimiter::new(
        rate_limit_per_second,
        rate_limit_burst,
        state.api_keys.clone(),
    ));

    router_with_limiter(state, limiter)
}

/// Render the OpenAPI document as YAML.
///
/// Used both by the `generate-openapi` binary and by the test that asserts the
/// committed `openapi.yaml` still matches the handlers.
pub fn openapi_yaml() -> Result<String, serde_yaml::Error> {
    serde_yaml::to_string(&ApiDoc::openapi())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn metrics_endpoint_serves_every_documented_family() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let progress = IngestionProgress::new();
        progress.observe_tip(50);
        progress.observe_ingested(45);
        let app = router(
            ApiState::new(
                Ingestor::new(store),
                AggregateCaches::from_secs(10),
                progress,
                60,
            ),
            20,
            40,
        );

        // A prior request proves the middleware and the scrape share one
        // registry. The scrape's own count is recorded after the body is built.
        let health = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .body(Body::empty())
                    .expect("health request"),
            )
            .await
            .expect("health response");
        assert_eq!(health.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .expect("scrape request"),
            )
            .await
            .expect("scrape response");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .expect("content type")
            .starts_with("text/plain"));

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let text = String::from_utf8(body.to_vec()).expect("utf-8 metrics");
        for family in [
            "soroban_indexer_ingestion_lag_ledgers",
            "soroban_indexer_events_ingested_total",
            "soroban_indexer_api_requests_total",
            "soroban_indexer_api_request_duration_seconds",
            "soroban_indexer_cache_hit_ratio",
            "soroban_indexer_rate_limit_rejections_total",
            "soroban_indexer_websocket_connections",
        ] {
            assert!(
                text.contains(&format!("# TYPE {family}")),
                "missing {family} in:\n{text}"
            );
        }
        assert!(text.contains("soroban_indexer_ingestion_lag_ledgers 5"));
        assert!(text.contains("route=\"/v1/health\",status=\"2xx\"} 1"));
    }

    #[test]
    fn the_openapi_document_describes_every_route() {
        let doc = ApiDoc::openapi();
        let paths: Vec<&str> = doc.paths.paths.keys().map(String::as_str).collect();

        for expected in [
            "/health",
            "/tasks/{task_id}",
            "/owners/{owner}/tasks",
            "/keepers/{keeper}/tasks",
            "/admin/config",
            "/feeds/open-tasks",
            "/events",
            "/leaderboard",
        ] {
            assert!(
                paths.contains(&expected),
                "{expected} missing from the generated document, have {paths:?}"
            );
        }
    }

    #[test]
    fn the_committed_openapi_file_matches_the_handlers() {
        let committed = include_str!("../../openapi.yaml");
        let current = openapi_yaml().expect("renders");

        assert_eq!(
            committed.trim(),
            current.trim(),
            "openapi.yaml is stale; regenerate it with              `cargo run -p keeper-indexer --bin generate-openapi`"
        );
    }

    #[test]
    fn the_document_is_generated_not_hand_written() {
        // The schemas come from the same types the handlers return, so a
        // renamed field cannot silently diverge from the published contract.
        let doc = ApiDoc::openapi();
        let components = doc.components.expect("components are generated");
        assert!(components.schemas.contains_key("TaskState"));
        assert!(components.schemas.contains_key("IndexedEvent"));
        assert!(components.schemas.contains_key("EventFeedResponse"));
    }
}
