//! Off-chain event indexer for the keeper registry contract.
//!
//! The contract emits every state change as an event (see
//! `contracts/keeper-registry/src/events.rs`). This crate stores those events
//! so a dashboard, a keeper bot, or an auditor can answer questions the
//! contract's own views cannot — "what has this address done", "when did the
//! fee last change" — without replaying the chain client-side.
//!
//! The design principle throughout is **history first, state derived**: every
//! event is stored as its own immutable row, and current-state answers are
//! views over that history rather than mutable columns that later events
//! overwrite. That is what makes the audit-trail requirement and the
//! agreement-with-the-contract checks possible at the same time.
//!
//! See `docs/INDEXER_DESIGN.md` for the architecture and
//! `docs/INDEXER_DEPLOYMENT.md` for running one.

pub mod event;
pub mod numeric;

use tokio_postgres::Client;

/// Anything that can go wrong applying events to the database.
#[derive(Debug, thiserror::Error)]
pub enum IndexerError {
    #[error("database error: {0}")]
    Database(#[from] tokio_postgres::Error),

    /// A `NUMERIC` column did not hold the scale-0 integer this crate writes.
    #[error("could not read `{0}` as an i128 amount")]
    Numeric(String),
}

/// The schema files applied by [`apply_schema`], in application order.
///
/// They are embedded rather than read from disk so a deployed binary carries
/// its own schema and cannot drift from the source tree it was built out of.
pub const SCHEMA_FILES: &[(&str, &str)] = &[
    ("keepers", include_str!("schema/keepers.sql")),
    ("admin", include_str!("schema/admin.sql")),
    ("tasks", include_str!("schema/tasks.sql")),
];

/// Create every table, index and view this crate reads.
///
/// Each statement is `IF NOT EXISTS` / `OR REPLACE`, so this is safe to run on
/// every start rather than only on a fresh database.
pub async fn apply_schema(client: &Client) -> Result<(), IndexerError> {
    for (_name, sql) in SCHEMA_FILES {
        client.batch_execute(sql).await?;
    }
    Ok(())
}

/// Apply a batch of events to every table that owns part of them.
///
/// Each module ignores the events it does not own, so the caller hands the
/// whole stream to all of them rather than routing on the topic itself.
pub async fn ingest_all(client: &Client, events: &[event::Event]) -> Result<(), IndexerError> {
    for event in events {
        ingest::keepers::ingest_event(client, event).await?;
        ingest::admin::ingest_event(client, event).await?;
        ingest::tasks::ingest_event(client, event).await?;
    }
    Ok(())
}
//! Event indexer for the Soroban keeper registry.
//!
//! The indexer polls the registry contract's events, stores them in an
//! append-only log, and serves both point-in-time queries (REST) and a live
//! feed (WebSocket) over that log. Every current-state answer is folded from
//! the stored history rather than kept as separate mutable state, so a derived
//! view cannot disagree with the events that produced it.
//!
//! Module layout:
//! - [`events`] -- the fifteen contract events as typed values, shared by
//!   storage and both API surfaces.
//! - [`rpc`] -- the event source ingestion reads from.
//! - [`ingest`] -- the single raw-event-to-stored-row path.
//! - [`store`] -- persistence and cursor-paged reads.
//! - [`state`] -- folds mirroring the contract's own views.
//! - [`backfill`] -- the ledger walk shared by catch-up and steady state.
//! - [`queries`] -- aggregate folds the API exposes, such as the leaderboard.

pub mod api;
pub mod backfill;
pub mod config;
pub mod events;
pub mod ingest;
pub mod queries;
pub mod rpc;
pub mod state;
pub mod store;

pub use backfill::Backfiller;
pub use config::Config;
pub use events::{EventPayload, EventType, IndexedEvent};
pub use ingest::Ingestor;
pub use store::Store;
