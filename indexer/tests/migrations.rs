//! Issue 0232: schema changes are one command, recorded, and data-safe.
//!
//! The tool under test is sqlx's migrator as this crate wires it — the same
//! Migrator the service runs at startup and `--migrate-only` runs from a
//! pipeline. Gated on `INDEXER_TEST_DATABASE_URL` exactly like
//! tests/idempotency.rs (printed skip, suite stays green without Postgres).

use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::path::Path;

static DB_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("INDEXER_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            eprintln!("skipping: INDEXER_TEST_DATABASE_URL not set");
            return None;
        }
    };
    // Fixtures run in their own SCHEMA, not just their own version range:
    // sqlx keeps one _sqlx_migrations record per schema and cross-checks
    // every applied version against the resolved source, so fixture rows in
    // the shared record would make every later run of the REAL migrator
    // fail with VersionMissing. search_path isolation gives the fixtures a
    // record of their own and leaves the real one untouched.
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("create schema if not exists migrate_fixtures")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("set search_path to migrate_fixtures")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .expect("connect to INDEXER_TEST_DATABASE_URL");
    // A truly fresh slate for every test: the whole fixture schema goes —
    // tables and migration record alike — so "fresh database, one command"
    // is real.
    sqlx::query("drop schema if exists migrate_fixtures cascade")
        .execute(&pool)
        .await
        .expect("reset");
    // `if not exists`: a second pool connection's after_connect hook may
    // race this recreate with its own idempotent create.
    sqlx::query("create schema if not exists migrate_fixtures")
        .execute(&pool)
        .await
        .expect("recreate fixture schema");
    Some(pool)
}

async fn run(dir: &str, pool: &PgPool) {
    let path = format!("{}/{}", env!("CARGO_MANIFEST_DIR"), dir);
    sqlx::migrate::Migrator::new(Path::new(&path))
        .await
        .expect("load migrations")
        .run(pool)
        .await
        .expect("apply migrations");
}

#[tokio::test]
async fn a_fresh_database_reaches_current_schema_with_one_command() {
    let _guard = DB_LOCK.lock().await;
    let Some(pool) = pool().await else { return };

    run("tests/fixtures/migrate-v2", &pool).await;

    // Schema is current…
    sqlx::query("insert into fixture_tasks (id, status, claimed_by) values (1, 'x', 'k')")
        .execute(&pool)
        .await
        .expect("current schema accepts current-shape rows");
    // …and every applied migration is on record.
    let applied = sqlx::query("select count(*) as n from _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<i64, _>("n");
    assert_eq!(applied, 2, "both migrations recorded");

    // Re-running the same command is a no-op, not a failure.
    run("tests/fixtures/migrate-v2", &pool).await;
}

#[tokio::test]
async fn an_existing_database_with_data_migrates_forward_without_loss() {
    let _guard = DB_LOCK.lock().await;
    let Some(pool) = pool().await else { return };

    // Yesterday's deployment: schema v1, live data.
    run("tests/fixtures/migrate-v1", &pool).await;
    sqlx::query("insert into fixture_tasks (id, status) values (7, 'registered')")
        .execute(&pool)
        .await
        .expect("v1 write");

    // Today's deploy: the same command, now with one more migration file.
    run("tests/fixtures/migrate-v2", &pool).await;

    // The data survived and the new column exists.
    let row = sqlx::query("select status, claimed_by from fixture_tasks where id = 7")
        .fetch_one(&pool)
        .await
        .expect("row survived the forward migration");
    assert_eq!(row.get::<String, _>("status"), "registered");
    assert_eq!(row.get::<Option<String>, _>("claimed_by"), None);
}

#[tokio::test]
async fn editing_an_applied_migration_fails_loudly() {
    let _guard = DB_LOCK.lock().await;
    let Some(pool) = pool().await else { return };

    // The record carries checksums: history is append-only, and a database
    // that ran one version of 9001 refuses a differently-worded 9001 —
    // that is what makes "which migrations have run" trustworthy. (Fixture
    // versions live in the 9xxx range so a shared test database can never
    // confuse them with the real migrations' record.)
    run("tests/fixtures/migrate-v1", &pool).await;

    let tampered = format!(
        "{}/tests/fixtures/migrate-tampered",
        env!("CARGO_MANIFEST_DIR")
    );
    let err = sqlx::migrate::Migrator::new(Path::new(&tampered))
        .await
        .expect("load tampered dir")
        .run(&pool)
        .await
        .expect_err("a changed checksum for an applied version must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("was previously applied") || msg.contains("checksum"),
        "unexpected error: {msg}"
    );
}
