//! A seeded API server for the load test (issue 0242).
//!
//! `indexer/loadtest/run.mjs` needs something to point at, and the service
//! loop that will serve the API in production has not landed yet. Rather than
//! having the load test measure a stub — which would measure the stub — this
//! boots the **real** router over the **real** store, seeded with a realistic
//! event history, and holds it open.
//!
//! `#[ignore]`d, so `cargo test` never starts a long-running server. Run it
//! deliberately:
//!
//! ```text
//! LOADTEST_EVENTS=20000 LOADTEST_PORT=8080 LOADTEST_SECS=120 \
//!   cargo test --test loadtest_server -- --ignored --nocapture
//! ```
//!
//! then, in another shell, `node indexer/loadtest/run.mjs`.

use std::time::Duration;

use keeper_indexer::api::{router, ApiState};
use keeper_indexer::cache::AggregateCaches;
use keeper_indexer::ingest::Ingestor;
use keeper_indexer::rpc::{RawEvent, RawValue};
use keeper_indexer::store::Store;
use tokio::net::TcpListener;

fn env_or(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn registered(tx: &str, task_id: u64, owner: &str, close_time: i64) -> RawEvent {
    RawEvent {
        ledger: (task_id / 4 + 10) as u32,
        ledger_close_time: close_time,
        tx_hash: tx.to_string(),
        event_index: 0,
        topics: vec!["reg".into(), "task".into()],
        values: vec![
            RawValue::U64(task_id),
            RawValue::Address(owner.into()),
            RawValue::I128(100),
            RawValue::U64(900),
        ],
    }
}

fn executed(tx: &str, task_id: u64, keeper: &str, close_time: i64) -> RawEvent {
    RawEvent {
        ledger: (task_id / 4 + 11) as u32,
        ledger_close_time: close_time,
        tx_hash: tx.to_string(),
        event_index: 1,
        topics: vec!["exec".into(), "task".into()],
        values: vec![
            RawValue::U64(task_id),
            RawValue::Address(keeper.into()),
            RawValue::I128(90),
            RawValue::Bytes("00".into()),
        ],
    }
}

#[tokio::test]
#[ignore = "long-running server for the load test; see indexer/loadtest/"]
async fn serve_seeded_api_for_loadtest() {
    let events = env_or("LOADTEST_EVENTS", 20_000);
    let port = env_or("LOADTEST_PORT", 8080);
    let secs = env_or("LOADTEST_SECS", 120);
    // Spread executions across this many keepers, so the leaderboard has a
    // realistic number of groups to fold and rank rather than one.
    let keepers = env_or("LOADTEST_KEEPERS", 250);

    let store = Store::connect("sqlite::memory:").await.expect("store");
    let ingestor = Ingestor::new(store);

    eprintln!("seeding {events} events across {keepers} keepers…");
    let mut batch = Vec::with_capacity(500);
    for i in 0..events {
        let keeper = format!("GKEEPER{:049}", i % keepers);
        let owner = format!("GOWNER{:050}", i % 97);
        // A close time that advances, so `since` windows select real subsets.
        let close_time = 1_700_000_000 + (i as i64);
        batch.push(registered(&format!("txr{i}"), i, &owner, close_time));
        batch.push(executed(&format!("txe{i}"), i, &keeper, close_time));
        if batch.len() >= 500 {
            ingestor.ingest_batch(&batch).await.expect("ingest");
            batch.clear();
        }
    }
    if !batch.is_empty() {
        ingestor.ingest_batch(&batch).await.expect("ingest");
    }

    let app = router(
        ApiState {
            ingestor,
            // The TTL under test. Set LOADTEST_CACHE_TTL_SECS=0 to measure the
            // uncached path for comparison.
            caches: AggregateCaches::from_secs(env_or("LOADTEST_CACHE_TTL_SECS", 10)),
        },
        // A load test measures the server itself, not its rate limiter.
        u32::MAX,
        u32::MAX,
    );

    let listener = TcpListener::bind(("127.0.0.1", port as u16))
        .await
        .expect("bind");
    eprintln!("serving on http://127.0.0.1:{port} for {secs}s");

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::sleep(Duration::from_secs(secs)).await;
    eprintln!("load-test window elapsed; shutting down");
}
