//! Aggregate queries over the ingested event log.
//!
//! These are read-only folds the API exposes directly, kept here rather than
//! in the handlers so the aggregation is testable on its own and every
//! consumer gets identical numbers and identical ordering.

pub mod leaderboard;
