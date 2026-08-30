//! Issue 0230: ingestion is idempotent under duplicate delivery.
//!
//! RPC sources can redeliver an event the indexer already processed (a
//! retried poll whose timed-out response actually landed; an at-least-once
//! streaming source; an operator re-running a range). These tests feed the
//! same events through the real apply path twice — against a real Postgres,
//! because the uniqueness key is enforced by the database, and a mock that
//! reimplements `on conflict` would be testing the mock.
//!
//! Gated on `INDEXER_TEST_DATABASE_URL`: without it each test prints a skip
//! notice and passes, so `cargo test --workspace --locked` stays green in
//! environments without Postgres. Locally:
//!
//! ```sh
//! docker run -d --rm -e POSTGRES_PASSWORD=pw -p 55440:5432 postgres:16-alpine
//! INDEXER_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55440/postgres \
//!     cargo test -p keeper-indexer --test idempotency
//! ```

use keeper_indexer::ingest::{apply, Applied, Event};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

const CONTRACT: &str = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CLOSED_AT: &str = "2026-08-30T00:00:00Z";

/// The tests share one database and each starts from truncated tables, so
/// they hold this for their whole run rather than racing each other's
/// snapshots.
static DB_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("INDEXER_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            eprintln!("skipping: INDEXER_TEST_DATABASE_URL not set");
            return None;
        }
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect to INDEXER_TEST_DATABASE_URL");
    let migrations = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
    sqlx::migrate::Migrator::new(std::path::Path::new(migrations))
        .await
        .expect("load migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    sqlx::query("truncate events, tasks, keepers, ingest_cursor")
        .execute(&pool)
        .await
        .expect("truncate");
    Some(pool)
}

/// Everything the duplicate must not change, snapshotted in one struct so
/// "identical to feeding it once" is a single equality, not a checklist.
#[derive(Debug, PartialEq)]
struct Snapshot {
    raw_events: i64,
    tasks: Vec<(i64, String, String, Option<String>)>, // id, status, reward, executed_by
    keepers: Vec<(String, String, String, i64, i64)>,  // keeper, balance, lifetime, exec, claimed
}

async fn snapshot(pool: &PgPool) -> Snapshot {
    let raw_events = sqlx::query("select count(*) as n from events")
        .fetch_one(pool)
        .await
        .unwrap()
        .get::<i64, _>("n");
    let tasks = sqlx::query(
        "select task_id, status, reward::text as reward, executed_by
         from tasks order by task_id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| {
        (
            r.get::<i64, _>("task_id"),
            r.get::<String, _>("status"),
            r.get::<String, _>("reward"),
            r.get::<Option<String>, _>("executed_by"),
        )
    })
    .collect();
    let keepers = sqlx::query(
        "select keeper, balance::text as balance, lifetime_earned::text as lifetime,
                tasks_executed, tasks_claimed
         from keepers order by keeper",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| {
        (
            r.get::<String, _>("keeper"),
            r.get::<String, _>("balance"),
            r.get::<String, _>("lifetime"),
            r.get::<i64, _>("tasks_executed"),
            r.get::<i64, _>("tasks_claimed"),
        )
    })
    .collect();
    Snapshot {
        raw_events,
        tasks,
        keepers,
    }
}

fn owner() -> String {
    "GAOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF".into()
}
fn keeper() -> String {
    "GAKEEPERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF".into()
}

#[tokio::test]
async fn redelivered_event_changes_nothing() {
    let _guard = DB_LOCK.lock().await;
    let Some(pool) = pool().await else { return };

    let ev = Event::TaskRegistered {
        task_id: 7,
        owner: owner(),
        reward: 1_000_000,
        deadline: 999,
    };
    let first = apply(
        &pool,
        "0000000000000000001-0000000000",
        100,
        CLOSED_AT,
        CONTRACT,
        &ev,
    )
    .await
    .unwrap();
    assert_eq!(first, Applied::Inserted);

    let once = snapshot(&pool).await;
    assert_eq!(once.raw_events, 1);
    assert_eq!(once.tasks.len(), 1);

    // The same event, byte for byte — a retried poll whose first response
    // actually landed. Same id, so the raw insert conflicts and every
    // derived effect is skipped.
    let second = apply(
        &pool,
        "0000000000000000001-0000000000",
        100,
        CLOSED_AT,
        CONTRACT,
        &ev,
    )
    .await
    .unwrap();
    assert_eq!(second, Applied::Duplicate);
    assert_eq!(
        snapshot(&pool).await,
        once,
        "stored state must equal feeding it once"
    );
}

#[tokio::test]
async fn derived_views_survive_duplicates_across_a_full_lifecycle() {
    let _guard = DB_LOCK.lock().await;
    let Some(pool) = pool().await else { return };

    // register → claim → execute → withdraw, each event delivered TWICE in
    // an at-least-once pattern (duplicate immediately after the original —
    // the retried-poll shape). Balances and task status must come out as if
    // each event arrived once.
    let lifecycle: [(&str, u32, Event); 4] = [
        (
            "0000000000000000002-0000000000",
            200,
            Event::TaskRegistered {
                task_id: 9,
                owner: owner(),
                reward: 500,
                deadline: 900,
            },
        ),
        (
            "0000000000000000003-0000000000",
            201,
            Event::TaskClaimed {
                task_id: 9,
                keeper: keeper(),
                ledger: 201,
            },
        ),
        (
            "0000000000000000004-0000000000",
            202,
            Event::TaskExecuted {
                task_id: 9,
                keeper: keeper(),
                net_reward: 450,
                proof: vec![1],
            },
        ),
        (
            "0000000000000000005-0000000000",
            203,
            Event::RewardsWithdrawn {
                keeper: keeper(),
                amount: 400,
            },
        ),
    ];

    for (id, ledger, ev) in &lifecycle {
        assert_eq!(
            apply(&pool, id, *ledger, CLOSED_AT, CONTRACT, ev)
                .await
                .unwrap(),
            Applied::Inserted
        );
        assert_eq!(
            apply(&pool, id, *ledger, CLOSED_AT, CONTRACT, ev)
                .await
                .unwrap(),
            Applied::Duplicate,
            "redelivery of {id} must be detected"
        );
    }

    let state = snapshot(&pool).await;
    assert_eq!(state.raw_events, 4, "four distinct events, not eight");
    assert_eq!(
        state.tasks,
        vec![(9, "executed".into(), "500".into(), Some(keeper()))]
    );
    // balance = 450 earned once - 400 withdrawn once = 50; a double-applied
    // execute would read 500, a double-applied withdraw would read -350.
    assert_eq!(
        state.keepers,
        vec![(keeper(), "50".into(), "450".into(), 1, 1)]
    );
}

#[tokio::test]
async fn same_ledger_different_position_is_not_a_duplicate() {
    let _guard = DB_LOCK.lock().await;
    let Some(pool) = pool().await else { return };

    // The key is (ledger, tx order, op index, event index) — NOT the ledger
    // alone. Two registrations in one ledger (a batch_register emits one
    // event per entry) must both land.
    let a = Event::TaskRegistered {
        task_id: 1,
        owner: owner(),
        reward: 100,
        deadline: 50,
    };
    let b = Event::TaskRegistered {
        task_id: 2,
        owner: owner(),
        reward: 100,
        deadline: 50,
    };
    apply(
        &pool,
        "0000000000000000006-0000000000",
        300,
        CLOSED_AT,
        CONTRACT,
        &a,
    )
    .await
    .unwrap();
    let second = apply(
        &pool,
        "0000000000000000006-0000000001",
        300,
        CLOSED_AT,
        CONTRACT,
        &b,
    )
    .await
    .unwrap();
    assert_eq!(second, Applied::Inserted);
    assert_eq!(snapshot(&pool).await.tasks.len(), 2);
}
