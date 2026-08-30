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
