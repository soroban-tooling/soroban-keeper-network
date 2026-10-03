//! One-command schema migration (issue #360).
//!
//! The indexer already applies pending migrations on every start
//! (`Store::connect` runs the embedded sqlx migrator), so a *deploy* never
//! needs this binary. What it adds is the operational half of the issue:
//! migrating a database **without** starting an indexer against it — ahead
//! of a rollout, against a restored backup, or just to see what would run.
//!
//! ```bash
//! INDEXER_DATABASE_URL=sqlite://indexer.db cargo run -p keeper-indexer --bin migrate
//! # or
//! cargo run -p keeper-indexer --bin migrate -- sqlite://indexer.db
//! ```
//!
//! The migrator is `sqlx::migrate!` over `indexer/migrations/` — embedded at
//! compile time, so a deployed binary carries exactly the migrations of the
//! source tree it was built from, and "which migrations have run" is the
//! `_sqlx_migrations` table sqlx maintains in the target database itself.

use std::collections::HashSet;
use std::str::FromStr;

use anyhow::{bail, Context, Result};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::Row;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let url = match std::env::args().nth(1) {
        Some(url) => url,
        None => match std::env::var("INDEXER_DATABASE_URL") {
            Ok(url) if !url.trim().is_empty() => url,
            _ => bail!(
                "no database given: pass it as the first argument or set INDEXER_DATABASE_URL"
            ),
        },
    };

    let options = SqliteConnectOptions::from_str(&url)
        .with_context(|| format!("invalid database url: {url}"))?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .context("connecting to the database")?;

    // What has already run, so the report can say applied vs. current.
    // A fresh database has no bookkeeping table yet; that simply means
    // nothing has been applied.
    let already: HashSet<i64> = sqlx::query("SELECT version FROM _sqlx_migrations")
        .fetch_all(&pool)
        .await
        .map(|rows| rows.iter().map(|r| r.get::<i64, _>("version")).collect())
        .unwrap_or_default();

    MIGRATOR.run(&pool).await.context("applying migrations")?;

    for migration in MIGRATOR.iter() {
        let state = if already.contains(&migration.version) {
            "already applied"
        } else {
            "applied"
        };
        println!(
            "{:>15}  {:04} {}",
            state, migration.version, migration.description
        );
    }
    println!("database is at the current schema");
    Ok(())
}
