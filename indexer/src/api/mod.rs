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

pub mod rate_limit;
pub mod rest;
pub mod types;
pub mod websocket;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;

use crate::ingest::Ingestor;
use rate_limit::RateLimiter;

/// Shared state every handler reads from.
#[derive(Clone)]
pub struct ApiState {
    pub ingestor: Ingestor,
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
    )),
    tags((name = "indexer", description = "Indexed registry data"))
)]
pub struct ApiDoc;

/// Build the API router, rate limited per client (by `X-API-Key`, else IP)
/// on both REST routes and the WebSocket upgrade.
pub fn router(state: ApiState, rate_limit_per_second: u32, rate_limit_burst: u32) -> Router {
    let limiter = Arc::new(RateLimiter::new(rate_limit_per_second, rate_limit_burst));

    Router::new()
        .nest("/v1", rest::routes())
        .route("/v1/stream", axum::routing::get(websocket::subscribe))
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(
            limiter,
            rate_limit::enforce,
        ))
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
