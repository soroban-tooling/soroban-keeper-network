//! REST handlers.
//!
//! Every route answers one of the query shapes the design document identified
//! as a real consumer need: a task with its history, tasks by owner, tasks by
//! keeper, the current admin config, and a paginated event feed.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use super::types::{
    AdminConfigResponse, ApiError, EventFeedResponse, HealthResponse, TaskDetail, TaskListResponse,
};
use super::ApiState;
use crate::events::EventType;
use crate::queries::leaderboard::{leaderboard, Leaderboard, RankBy};

/// Default events per page when the caller does not say.
const DEFAULT_PAGE_SIZE: u32 = 50;
/// Largest page a caller may request, so one request cannot pull the feed.
const MAX_PAGE_SIZE: u32 = 500;

/// Every v1 route.
pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/health", get(health))
        .route("/tasks/{task_id}", get(get_task))
        .route("/owners/{owner}/tasks", get(tasks_by_owner))
        .route("/keepers/{keeper}/tasks", get(tasks_by_keeper))
        .route("/admin/config", get(admin_config))
        .route("/leaderboard", get(keeper_leaderboard))
        .route("/events", get(event_feed))
}

/// An error with the status it should be reported as.
///
/// Public because the handlers returning it are public for the OpenAPI
/// derivation; callers construct errors through the helpers below.
pub struct Failure(StatusCode, ApiError);

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

/// Map an internal error to a 500 without leaking its detail to the caller.
fn internal(err: anyhow::Error) -> Failure {
    tracing::error!(error = %err, "request failed");
    Failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        ApiError::new("internal_error", "the request could not be completed"),
    )
}

fn not_found(what: &str) -> Failure {
    Failure(StatusCode::NOT_FOUND, ApiError::new("not_found", what))
}

/// Service liveness and ingestion progress.
#[utoipa::path(
    get,
    path = "/health",
    tag = "indexer",
    responses((status = 200, description = "Service is running", body = HealthResponse))
)]
pub async fn health(State(state): State<ApiState>) -> Result<Json<HealthResponse>, Failure> {
    let checkpoint = state
        .ingestor
        .store()
        .checkpoint()
        .await
        .map_err(internal)?;

    Ok(Json(HealthResponse {
        status: "ok".to_string(),
        last_ingested_ledger: checkpoint.map(|c| c.last_ledger),
        backfill_complete: checkpoint.is_some_and(|c| c.backfill_complete),
    }))
}

/// One task, with its full observed history.
#[utoipa::path(
    get,
    path = "/tasks/{task_id}",
    tag = "indexer",
    params(("task_id" = u64, Path, description = "Task id")),
    responses(
        (status = 200, description = "Task state and history", body = TaskDetail),
        (status = 404, description = "No such task has been indexed", body = ApiError)
    )
)]
pub async fn get_task(
    State(state): State<ApiState>,
    Path(task_id): Path<u64>,
) -> Result<Json<TaskDetail>, Failure> {
    let store = state.ingestor.store();
    let history = store.task_history(task_id).await.map_err(internal)?;
    let task = store
        .task_state(task_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("no task with that id has been indexed"))?;

    Ok(Json(TaskDetail { task, history }))
}

/// Tasks registered by an owner.
#[utoipa::path(
    get,
    path = "/owners/{owner}/tasks",
    tag = "indexer",
    params(("owner" = String, Path, description = "Owner address")),
    responses((status = 200, description = "Tasks for the owner", body = TaskListResponse))
)]
pub async fn tasks_by_owner(
    State(state): State<ApiState>,
    Path(owner): Path<String>,
) -> Result<Json<TaskListResponse>, Failure> {
    let store = state.ingestor.store();
    let ids = store.task_ids_by_owner(&owner).await.map_err(internal)?;

    let mut tasks = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(task) = store.task_state(id).await.map_err(internal)? {
            tasks.push(task);
        }
    }

    Ok(Json(TaskListResponse {
        address: owner,
        tasks,
    }))
}

/// Tasks a keeper has claimed or executed.
#[utoipa::path(
    get,
    path = "/keepers/{keeper}/tasks",
    tag = "indexer",
    params(("keeper" = String, Path, description = "Keeper address")),
    responses((status = 200, description = "Tasks for the keeper", body = TaskListResponse))
)]
pub async fn tasks_by_keeper(
    State(state): State<ApiState>,
    Path(keeper): Path<String>,
) -> Result<Json<TaskListResponse>, Failure> {
    let store = state.ingestor.store();
    let ids = store.task_ids_by_keeper(&keeper).await.map_err(internal)?;

    let mut tasks = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(task) = store.task_state(id).await.map_err(internal)? {
            tasks.push(task);
        }
    }

    Ok(Json(TaskListResponse {
        address: keeper,
        tasks,
    }))
}

/// Current registry configuration.
#[utoipa::path(
    get,
    path = "/admin/config",
    tag = "indexer",
    responses((status = 200, description = "Current configuration", body = AdminConfigResponse))
)]
pub async fn admin_config(
    State(state): State<ApiState>,
) -> Result<Json<AdminConfigResponse>, Failure> {
    let config = state
        .ingestor
        .store()
        .admin_config()
        .await
        .map_err(internal)?;
    Ok(Json(config))
}

/// Default entries returned by the leaderboard.
const DEFAULT_LEADERBOARD_SIZE: u32 = 25;
/// Largest leaderboard a caller may request.
const MAX_LEADERBOARD_SIZE: u32 = 200;

/// Query parameters for the leaderboard.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LeaderboardQuery {
    /// `executions` (default) or `reward`.
    pub rank_by: Option<String>,
    /// Only count executions at or after this Unix timestamp; omit for all time.
    pub since: Option<i64>,
    /// Entries to return, capped at 200.
    pub limit: Option<u32>,
}

/// Keepers ranked by executions or by total net reward.
///
/// Ties are broken deterministically: by the other metric, then by keeper
/// address ascending. See `queries::leaderboard` for the full rule.
#[utoipa::path(
    get,
    path = "/leaderboard",
    tag = "indexer",
    params(
        ("rank_by" = Option<String>, Query, description = "executions (default) or reward"),
        ("since" = Option<i64>, Query, description = "Unix timestamp; omit for all time"),
        ("limit" = Option<u32>, Query, description = "Entries to return (default 25, max 200)")
    ),
    responses(
        (status = 200, description = "Ranked keepers", body = Leaderboard),
        (status = 400, description = "Unknown ranking metric", body = ApiError)
    )
)]
pub async fn keeper_leaderboard(
    State(state): State<ApiState>,
    Query(query): Query<LeaderboardQuery>,
) -> Result<Json<Leaderboard>, Failure> {
    let rank_by = match query.rank_by.as_deref() {
        None => RankBy::Executions,
        Some(name) => RankBy::parse(name).ok_or_else(|| {
            Failure(
                StatusCode::BAD_REQUEST,
                ApiError::new(
                    "unknown_rank_by",
                    format!("no such ranking metric: {name}; expected executions or reward"),
                ),
            )
        })?,
    };

    let limit = query
        .limit
        .unwrap_or(DEFAULT_LEADERBOARD_SIZE)
        .clamp(1, MAX_LEADERBOARD_SIZE);

    let board = leaderboard(state.ingestor.store(), rank_by, query.since, limit)
        .await
        .map_err(internal)?;

    Ok(Json(board))
}

/// Query parameters for the event feed.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FeedQuery {
    /// Cursor from a previous response's `next_cursor`.
    pub after: Option<i64>,
    /// Events per page, capped at 500.
    pub limit: Option<u32>,
    /// Restrict to one event type, by its wire name.
    pub event_type: Option<String>,
    /// Restrict to events mentioning this address, as owner or keeper.
    pub address: Option<String>,
}

/// A page of ingested events, oldest first.
#[utoipa::path(
    get,
    path = "/events",
    tag = "indexer",
    params(
        ("after" = Option<i64>, Query, description = "Cursor from a previous response"),
        ("limit" = Option<u32>, Query, description = "Events per page (default 50, max 500)"),
        ("event_type" = Option<String>, Query, description = "Filter by event type"),
        ("address" = Option<String>, Query, description = "Filter by owner or keeper address")
    ),
    responses(
        (status = 200, description = "A page of events", body = EventFeedResponse),
        (status = 400, description = "Unknown event type", body = ApiError)
    )
)]
pub async fn event_feed(
    State(state): State<ApiState>,
    Query(query): Query<FeedQuery>,
) -> Result<Json<EventFeedResponse>, Failure> {
    let event_type = match query.event_type.as_deref() {
        Some(name) => Some(EventType::parse(name).ok_or_else(|| {
            Failure(
                StatusCode::BAD_REQUEST,
                ApiError::new("unknown_event_type", format!("no such event type: {name}")),
            )
        })?),
        None => None,
    };

    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);

    let page = state
        .ingestor
        .store()
        .events_after(query.after, limit, event_type, query.address.as_deref())
        .await
        .map_err(internal)?;

    Ok(Json(EventFeedResponse {
        events: page.events,
        next_cursor: page.next_cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{router, ApiState};
    use crate::events::{EventPayload, I128};
    use crate::ingest::Ingestor;
    use crate::store::Store;
    use axum::body::Body;
    use axum::http::Request;
    // `oneshot` comes from tower's Service extension trait.
    use tower::ServiceExt as _;

    async fn app_with_events() -> axum::Router {
        let store = Store::connect("sqlite::memory:").await.expect("store");

        let events = [
            EventPayload::Initialized {
                admin: "GADMIN".into(),
                reward_token: "GTOKEN".into(),
                fee_bps: 100,
            },
            EventPayload::TaskRegistered {
                task_id: 1,
                owner: "GOWNER".into(),
                reward: I128(1_000),
                deadline: 9_000,
            },
            EventPayload::TaskClaimed {
                task_id: 1,
                keeper: "GKEEPER".into(),
                claim_ledger: 150,
            },
            EventPayload::TaskExecuted {
                task_id: 1,
                keeper: "GKEEPER".into(),
                net_reward: I128(990),
                proof: "proof".into(),
            },
        ];

        for (i, payload) in events.iter().enumerate() {
            store
                .insert_event(100 + i as u32, 500, &format!("tx{i}"), 0, payload)
                .await
                .expect("insert");
        }

        router(
            ApiState {
                ingestor: Ingestor::new(store),
            },
            1_000,
            1_000,
        )
    }

    async fn get_json(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("json body")
        };
        (status, json)
    }

    #[tokio::test]
    async fn routes_are_served_under_the_v1_prefix() {
        let app = app_with_events().await;

        let (status, _) = get_json(&app, "/v1/health").await;
        assert_eq!(status, StatusCode::OK);

        // Unversioned paths are not served: the prefix is part of the contract
        // from the first release, not something added later.
        let (status, _) = get_json(&app, "/health").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_task_is_returned_with_its_full_history() {
        let app = app_with_events().await;
        let (status, body) = get_json(&app, "/v1/tasks/1").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["task"]["status"], "executed");
        // Reward is a string so large values survive a browser's JSON parse.
        assert_eq!(body["task"]["reward"], "1000");
        assert_eq!(body["task"]["net_reward"], "990");
        assert_eq!(body["history"].as_array().expect("history").len(), 3);
    }

    #[tokio::test]
    async fn an_unindexed_task_is_a_404_not_an_empty_task() {
        let app = app_with_events().await;
        let (status, body) = get_json(&app, "/v1/tasks/999").await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "not_found");
    }

    #[tokio::test]
    async fn tasks_are_queryable_by_owner_and_by_keeper() {
        let app = app_with_events().await;

        let (status, body) = get_json(&app, "/v1/owners/GOWNER/tasks").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["tasks"].as_array().expect("tasks").len(), 1);

        let (status, body) = get_json(&app, "/v1/keepers/GKEEPER/tasks").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["tasks"].as_array().expect("tasks").len(), 1);

        // An address with no activity gets an empty list, not an error.
        let (status, body) = get_json(&app, "/v1/owners/GNOBODY/tasks").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["tasks"].as_array().expect("tasks").is_empty());
    }

    #[tokio::test]
    async fn the_admin_config_reflects_the_ingested_events() {
        let app = app_with_events().await;
        let (status, body) = get_json(&app, "/v1/admin/config").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["admin"], "GADMIN");
        assert_eq!(body["fee_bps"], 100);
    }

    #[tokio::test]
    async fn the_feed_pages_by_cursor_without_repeating_events() {
        let app = app_with_events().await;

        let (status, first) = get_json(&app, "/v1/events?limit=2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["events"].as_array().expect("events").len(), 2);

        let cursor = first["next_cursor"].as_i64().expect("more pages");
        let (_, second) = get_json(&app, &format!("/v1/events?limit=2&after={cursor}")).await;

        let first_cursors: Vec<i64> = first["events"]
            .as_array()
            .expect("events")
            .iter()
            .map(|e| e["cursor"].as_i64().expect("cursor"))
            .collect();
        for event in second["events"].as_array().expect("events") {
            let cursor = event["cursor"].as_i64().expect("cursor");
            assert!(!first_cursors.contains(&cursor), "no event served twice");
        }
    }

    #[tokio::test]
    async fn the_last_page_reports_no_further_cursor() {
        let app = app_with_events().await;
        let (_, body) = get_json(&app, "/v1/events?limit=100").await;

        assert_eq!(body["events"].as_array().expect("events").len(), 4);
        assert!(body["next_cursor"].is_null(), "end of feed");
    }

    #[tokio::test]
    async fn the_feed_filters_by_event_type_and_address() {
        let app = app_with_events().await;

        let (_, body) = get_json(&app, "/v1/events?event_type=task_executed").await;
        assert_eq!(body["events"].as_array().expect("events").len(), 1);

        let (_, body) = get_json(&app, "/v1/events?address=GKEEPER").await;
        assert_eq!(body["events"].as_array().expect("events").len(), 2);
    }

    #[tokio::test]
    async fn an_unknown_event_type_is_rejected_rather_than_ignored() {
        let app = app_with_events().await;
        let (status, body) = get_json(&app, "/v1/events?event_type=not_an_event").await;

        // Silently returning an unfiltered feed would look like "no such
        // events exist" to a client with a typo in its filter.
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "unknown_event_type");
    }

    #[tokio::test]
    async fn the_leaderboard_is_served_and_ranks_by_executions_by_default() {
        let app = app_with_events().await;
        let (status, body) = get_json(&app, "/v1/leaderboard").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["rank_by"], "executions");
        let entries = body["entries"].as_array().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["keeper"], "GKEEPER");
        assert_eq!(entries[0]["rank"], 1);
        assert_eq!(entries[0]["total_reward"], "990");
    }

    #[tokio::test]
    async fn the_leaderboard_accepts_a_window_and_a_reward_ranking() {
        let app = app_with_events().await;

        let (status, body) = get_json(&app, "/v1/leaderboard?rank_by=reward").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["rank_by"], "reward");

        // The fixture's execution closes at 500, so a later window excludes it.
        let (_, body) = get_json(&app, "/v1/leaderboard?since=100000").await;
        assert!(body["entries"].as_array().expect("entries").is_empty());
        assert_eq!(body["since"], 100000);
    }

    #[tokio::test]
    async fn an_unknown_ranking_metric_is_rejected() {
        let app = app_with_events().await;
        let (status, body) = get_json(&app, "/v1/leaderboard?rank_by=popularity").await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "unknown_rank_by");
    }

    #[tokio::test]
    async fn an_oversized_page_request_is_capped_not_rejected() {
        let app = app_with_events().await;
        let (status, _) = get_json(&app, "/v1/events?limit=100000").await;
        assert_eq!(status, StatusCode::OK);
    }
}
