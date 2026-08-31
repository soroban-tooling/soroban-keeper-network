//! Shared setup for the database-backed tests.
//!
//! These tests need a real Postgres because the things worth testing — the
//! `ON CONFLICT` idempotency constraint, the balance view's arithmetic, the
//! "latest of each type wins" ordering — are properties of the database, not of
//! the Rust wrapping it. A mock would only assert that the code sends the SQL
//! it sends.
//!
//! `INDEXER_TEST_DATABASE_URL` gates them. When it is unset the tests skip
//! instead of failing, because the workspace-wide `cargo test` in the required
//! CI job (and on a contract contributor's laptop) has no database and should
//! not go red over it. CI sets the variable in the indexer job, where an
//! ephemeral Postgres service container is running — see `docs/CI.md`.

use std::sync::atomic::{AtomicU64, Ordering};

use keeper_indexer::apply_schema;
use tokio_postgres::{Client, NoTls};

/// Distinguishes concurrent tests within one process. Combined with the
/// process id below, it gives every test a namespace no other test can be
/// using.
static NEXT_SCHEMA_ID: AtomicU64 = AtomicU64::new(0);

/// Connect and set up an isolated schema, or return `None` if no test database
/// is configured.
///
/// Each test gets its **own Postgres schema**, not just its own tables. Cargo
/// runs tests in a file concurrently, and the two test files can run at once
/// too, so a shared namespace means one test creating its tables while another
/// is mid-assertion against the same names — which fails in whichever order
/// the scheduler happens to pick. Isolating the namespace fixes that at the
/// source rather than papering over it with `--test-threads=1`, which would
/// serialize the whole suite to work around it.
///
/// The schema is dropped when the connection ends, because it is created
/// inside the session's `search_path` and torn down explicitly below.
pub async fn test_client() -> Option<Client> {
    let url = std::env::var("INDEXER_TEST_DATABASE_URL").ok()?;

    let (client, connection) = tokio_postgres::connect(&url, NoTls)
        .await
        .expect("INDEXER_TEST_DATABASE_URL is set but the database is unreachable");

    // The connection drives the protocol and must be polled for the client to
    // make progress; it ends when the client is dropped.
    tokio::spawn(async move {
        let _ = connection.await;
    });

    // Process id keeps concurrently-running test *binaries* apart; the counter
    // keeps concurrent tests within one binary apart.
    let schema = format!(
        "idx_test_{}_{}",
        std::process::id(),
        NEXT_SCHEMA_ID.fetch_add(1, Ordering::Relaxed)
    );

    client
        .batch_execute(&format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE;
             CREATE SCHEMA {schema};
             SET search_path TO {schema};"
        ))
        .await
        .expect("failed to create the test schema");

    apply_schema(&client).await.expect("failed to apply schema");

    Some(client)
}

/// Skip the body of a test when no test database is configured.
///
/// Used as `let client = skip_without_db!();` at the top of each test.
#[macro_export]
macro_rules! skip_without_db {
    () => {
        match $crate::support::test_client().await {
            Some(client) => client,
            None => {
                eprintln!(
                    "skipping: INDEXER_TEST_DATABASE_URL is not set (see indexer/tests/support/mod.rs)"
                );
                return;
            }
        }
    };
}
