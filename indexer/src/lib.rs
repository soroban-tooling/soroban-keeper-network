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
//! Module layout:
//! - [`events`] — the fifteen contract events as typed values, shared by
//!   storage and both API surfaces.
//! - [`rpc`] — the event source ingestion reads from.
//! - [`ingest`] — the single raw-event-to-stored-row path.
//! - [`store`] — persistence and cursor-paged reads.
//! - [`state`] — folds mirroring the contract's own views.
//! - [`backfill`] — the ledger walk shared by catch-up and steady state.
//! - [`queries`] — aggregate folds the API exposes, such as the leaderboard.
//! - [`reorg`] — detecting a ledger the source later reports differently.
//! - [`service`] — the supervised lifecycle `main` runs: ingestion and the
//!   HTTP API together, shut down together.
//! - [`cache`] — a short-TTL cache in front of those folds, so dashboard
//!   traffic does not translate into repeated identical aggregation.
//!
//! See `docs/INDEXER_DESIGN.md` for the architecture and
//! `docs/INDEXER_DEPLOYMENT.md` for running one.

pub mod address;
pub mod api;
pub mod backfill;
pub mod cache;
pub mod config;
pub mod events;
pub mod ingest;
pub mod progress;
pub mod queries;
pub mod reorg;
pub mod rpc;
pub mod service;
pub mod state;
pub mod store;

pub use backfill::Backfiller;
pub use config::Config;
pub use events::{EventPayload, EventType, IndexedEvent};
pub use ingest::Ingestor;
pub use progress::{IngestionProgress, ProgressSnapshot};
pub use service::Service;
pub use store::Store;
