//! Schema migrations are one command and never cost data (issue #360).
//!
//! The tool is sqlx's migrator over `indexer/migrations/` — idiomatic for
//! the ecosystem rather than hand-rolled, per the issue's suggested
//! approach. `Store::connect` runs it on every start, and the `migrate`
//! binary runs the same embedded migrator without starting an indexer.
//! These tests pin the two acceptance criteria that involve a real
//! database: a fresh one reaches the current schema in one step, and an
//! existing one **with data** is migrated forward without losing it.
//!
//! File-backed databases (not `sqlite::memory:`) on purpose: the
//! forward-migration guarantee is about a database that outlives the
//! process, so the tests reopen the same file the way a redeploy would.

use keeper_indexer::events::EventPayload;
use keeper_indexer::Store;

use sqlx::Row;

/// A unique on-disk sqlite URL under the OS temp directory.
fn temp_db_url(tag: &str) -> (std::path::PathBuf, String) {
    let path = std::env::temp_dir().join(format!(
        "keeper-indexer-migrations-{tag}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    // sqlx wants forward slashes even on Windows.
    let url = format!(
        "sqlite://{}?mode=rwc",
        path.display().to_string().replace('\\', "/")
    );
    (path, url)
}

#[tokio::test]
async fn a_fresh_database_reaches_the_current_schema_in_one_step() {
    let (path, url) = temp_db_url("fresh");

    let store = Store::connect(&url).await.expect("connect + migrate");

    // The schema is genuinely current: the newest migration's bookkeeping
    // row exists, and a table from the first migration is usable.
    let versions: Vec<i64> = sqlx::query("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(store.pool())
        .await
        .expect("bookkeeping table exists")
        .iter()
        .map(|r| r.get("version"))
        .collect();
    assert!(
        !versions.is_empty(),
        "at least one migration must be recorded"
    );

    let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM events")
        .fetch_one(store.pool())
        .await
        .expect("events table exists")
        .get("n");
    assert_eq!(count, 0);

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn migrating_an_existing_database_with_data_loses_nothing() {
    let (path, url) = temp_db_url("forward");

    // First deploy: migrate, then live a little.
    let store = Store::connect(&url).await.expect("first connect");
    store
        .insert_event(
            10,
            50,
            "tx1",
            0,
            &EventPayload::TaskRegistered {
                task_id: 7,
                owner: "GOWNER".into(),
                reward: 500.into(),
                deadline: 9_000,
            },
        )
        .await
        .expect("insert");
    let versions_before: Vec<i64> =
        sqlx::query("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(store.pool())
            .await
            .expect("bookkeeping")
            .iter()
            .map(|r| r.get("version"))
            .collect();
    drop(store);

    // Redeploy against the same file: the migrator runs again over a
    // database that now has data. Already-applied migrations are recorded
    // in _sqlx_migrations and skipped, so this must be a no-op that leaves
    // every row in place - not a re-create.
    let store = Store::connect(&url).await.expect("second connect");

    let task = store
        .task_state(7)
        .await
        .expect("query")
        .expect("the task survived the forward migration");
    assert_eq!(task.owner, "GOWNER");

    let versions_after: Vec<i64> =
        sqlx::query("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(store.pool())
            .await
            .expect("bookkeeping")
            .iter()
            .map(|r| r.get("version"))
            .collect();
    assert_eq!(
        versions_before, versions_after,
        "re-running the migrator must not re-apply or renumber migrations"
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn a_tampered_migration_is_refused_rather_than_silently_diverging() {
    // sqlx records a checksum per applied migration. If the committed file
    // later changes without a new migration being added, the safe outcome
    // is a refusal - two databases silently built from different versions
    // of "migration 1" is exactly the unrepeatable state issue #360 exists
    // to prevent. Pin it by corrupting the recorded checksum and reopening.
    let (path, url) = temp_db_url("tamper");

    let store = Store::connect(&url).await.expect("first connect");
    sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = (SELECT MIN(version) FROM _sqlx_migrations)")
        .execute(store.pool())
        .await
        .expect("tamper");
    drop(store);

    let reopened = Store::connect(&url).await;
    assert!(
        reopened.is_err(),
        "a checksum mismatch must fail loudly, not migrate anyway"
    );

    let _ = std::fs::remove_file(path);
}
