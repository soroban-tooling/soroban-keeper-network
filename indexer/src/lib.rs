//! Library surface of the keeper indexer, so integration tests (and later
//! the API server) reuse the same modules the binary runs.

pub mod config;
pub mod health;
pub mod ingest;
pub mod rpc;
