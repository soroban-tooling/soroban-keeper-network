//! API response types.
//!
//! These are deliberately independent of the database schema. The store maps
//! into them, so a schema migration is a change to that mapping rather than a
//! breaking change every consumer has to absorb at the same moment.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::events::IndexedEvent;
use crate::state::{AdminConfig, TaskState};

/// An error returned by any endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    /// Stable, machine-readable code. Safe to branch on.
    pub error: String,
    /// Human-readable detail. Wording may change; do not parse it.
    pub message: String,
}

impl ApiError {
    pub fn new(error: &str, message: impl Into<String>) -> Self {
        Self {
            error: error.to_string(),
            message: message.into(),
        }
    }
}

/// Service liveness and how far ingestion has reached.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
    /// Highest ledger fully ingested, absent before the first checkpoint.
    pub last_ingested_ledger: Option<u32>,
    /// Whether the initial catch-up has finished.
    pub backfill_complete: bool,
}

/// A task's current state together with the events that produced it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TaskDetail {
    /// State folded from the full history below.
    pub task: TaskState,
    /// Every event for this task, oldest first.
    pub history: Vec<IndexedEvent>,
}

/// Tasks belonging to one address.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TaskListResponse {
    /// The address these tasks were selected by.
    pub address: String,
    pub tasks: Vec<TaskState>,
}

/// A page of the event feed.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EventFeedResponse {
    pub events: Vec<IndexedEvent>,
    /// Pass as `after` to fetch the next page; absent at the end of the feed.
    ///
    /// This is a stable cursor, not an offset: events ingested between two
    /// requests shift no boundary, so a client paging through the feed sees
    /// every event exactly once.
    pub next_cursor: Option<i64>,
}

/// Current registry configuration, folded from admin event history.
pub type AdminConfigResponse = AdminConfig;
