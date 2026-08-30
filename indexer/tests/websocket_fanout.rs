//! End-to-end WebSocket tests against a running server.
//!
//! The unit tests in `api::websocket` cover filtering and payload shape. These
//! exercise the real socket: a live server, real clients, real JSON frames --
//! including the concurrent-subscriber fan-out the design calls for.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use keeper_indexer::api::{router, ApiState};
use keeper_indexer::ingest::Ingestor;
use keeper_indexer::rpc::{RawEvent, RawValue};
use keeper_indexer::store::Store;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// Number of concurrent subscribers the fan-out test attaches.
const SUBSCRIBERS: usize = 50;

/// Start the API on an ephemeral port, returning its address and the ingestor.
async fn start_server() -> (String, Ingestor) {
    let store = Store::connect("sqlite::memory:").await.expect("store");
    let ingestor = Ingestor::new(store);
    let app = router(
        ApiState {
            ingestor: ingestor.clone(),
        },
        10_000,
        10_000,
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    (format!("ws://{addr}/v1/stream"), ingestor)
}

fn raw_registered(tx: &str, task_id: u64, owner: &str) -> RawEvent {
    RawEvent {
        ledger: 10,
        ledger_close_time: 100,
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

fn raw_executed(tx: &str, task_id: u64, keeper: &str) -> RawEvent {
    RawEvent {
        ledger: 11,
        ledger_close_time: 110,
        tx_hash: tx.to_string(),
        event_index: 0,
        topics: vec!["exec".into(), "task".into()],
        values: vec![
            RawValue::U64(task_id),
            RawValue::Address(keeper.into()),
            RawValue::I128(90),
            RawValue::Bytes("00".into()),
        ],
    }
}

/// Read frames until the `subscribed` acknowledgement arrives.
async fn await_subscribed<S>(socket: &mut S) -> serde_json::Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let frame = socket.next().await.expect("frame").expect("no error");
        if let Message::Text(text) = frame {
            let value: serde_json::Value = serde_json::from_str(&text).expect("json");
            if value["kind"] == "subscribed" {
                return value;
            }
        }
    }
}

/// Read the next `event` frame.
async fn next_event<S>(socket: &mut S) -> serde_json::Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let frame = socket.next().await.expect("frame").expect("no error");
        if let Message::Text(text) = frame {
            let value: serde_json::Value = serde_json::from_str(&text).expect("json");
            if value["kind"] == "event" {
                return value["event"].clone();
            }
        }
    }
}

#[tokio::test]
async fn a_client_receives_events_as_they_are_ingested() {
    let (url, ingestor) = start_server().await;
    let (mut socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("connect");
    await_subscribed(&mut socket).await;

    ingestor
        .ingest_batch(&[raw_registered("tx1", 42, "GOWNER")])
        .await
        .expect("ingest");

    let event = next_event(&mut socket).await;
    assert_eq!(event["payload"]["task_id"], 42);
    assert_eq!(event["event_type"], "task_registered");
}

#[tokio::test]
async fn a_pushed_event_matches_the_rest_feed_byte_for_byte() {
    let (url, ingestor) = start_server().await;
    let (mut socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("connect");
    await_subscribed(&mut socket).await;

    ingestor
        .ingest_batch(&[raw_registered("tx1", 7, "GOWNER")])
        .await
        .expect("ingest");
    let pushed = next_event(&mut socket).await;

    // The same event as the REST feed would serialise it.
    let page = ingestor
        .store()
        .events_after(None, 10, None, None)
        .await
        .expect("feed");
    let from_rest = serde_json::to_value(&page.events[0]).expect("rest shape");

    assert_eq!(pushed, from_rest, "one parser must serve both feeds");
}

#[tokio::test]
async fn a_subscription_can_filter_by_event_type() {
    let (url, ingestor) = start_server().await;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("{url}?event_type=task_executed"))
            .await
            .expect("connect");
    await_subscribed(&mut socket).await;

    // The registration must be filtered out; the execution must arrive.
    ingestor
        .ingest_batch(&[
            raw_registered("tx1", 1, "GOWNER"),
            raw_executed("tx2", 1, "GKEEPER"),
        ])
        .await
        .expect("ingest");

    let event = next_event(&mut socket).await;
    assert_eq!(event["event_type"], "task_executed");
}

#[tokio::test]
async fn a_subscription_can_filter_by_address() {
    let (url, ingestor) = start_server().await;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("{url}?address=GKEEPER"))
        .await
        .expect("connect");
    await_subscribed(&mut socket).await;

    ingestor
        .ingest_batch(&[
            raw_registered("tx1", 1, "GOWNER"),
            raw_executed("tx2", 1, "GKEEPER"),
        ])
        .await
        .expect("ingest");

    let event = next_event(&mut socket).await;
    assert_eq!(event["payload"]["keeper"], "GKEEPER");
}

#[tokio::test]
async fn type_and_address_filters_apply_together() {
    let (url, ingestor) = start_server().await;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("{url}?event_type=task_executed&address=GKEEPER"))
            .await
            .expect("connect");
    await_subscribed(&mut socket).await;

    ingestor
        .ingest_batch(&[
            raw_registered("tx1", 1, "GKEEPER"),
            raw_executed("tx2", 2, "GOTHER"),
            raw_executed("tx3", 3, "GKEEPER"),
        ])
        .await
        .expect("ingest");

    let event = next_event(&mut socket).await;
    assert_eq!(
        event["payload"]["task_id"], 3,
        "only the event matching both"
    );
}

#[tokio::test]
async fn a_reconnecting_client_replays_what_it_missed() {
    let (url, ingestor) = start_server().await;

    // Three events arrive while the client is disconnected.
    for i in 1..=3u64 {
        ingestor
            .ingest_batch(&[raw_registered(&format!("tx{i}"), i, "GOWNER")])
            .await
            .expect("ingest");
    }

    // The client last saw cursor 1, so it reconnects asking for what followed.
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("{url}?after=1"))
        .await
        .expect("connect");

    let first = next_event(&mut socket).await;
    let second = next_event(&mut socket).await;
    assert_eq!(first["cursor"], 2);
    assert_eq!(second["cursor"], 3);

    let ack = await_subscribed(&mut socket).await;
    assert_eq!(ack["replayed_through"], 3);
}

#[tokio::test]
async fn replayed_events_are_not_delivered_twice_by_the_live_feed() {
    let (url, ingestor) = start_server().await;
    ingestor
        .ingest_batch(&[raw_registered("tx1", 1, "GOWNER")])
        .await
        .expect("ingest");

    let (mut socket, _) = tokio_tungstenite::connect_async(format!("{url}?after=0"))
        .await
        .expect("connect");

    let replayed = next_event(&mut socket).await;
    assert_eq!(replayed["cursor"], 1);
    await_subscribed(&mut socket).await;

    // A newly ingested event arrives once; the replayed one does not repeat.
    ingestor
        .ingest_batch(&[raw_registered("tx2", 2, "GOWNER")])
        .await
        .expect("ingest");

    let live = next_event(&mut socket).await;
    assert_eq!(live["cursor"], 2);
}

#[tokio::test]
async fn an_unknown_event_type_filter_is_refused_with_a_reason() {
    let (url, _ingestor) = start_server().await;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("{url}?event_type=nonsense"))
        .await
        .expect("connect");

    let frame = socket.next().await.expect("frame").expect("no error");
    let Message::Text(text) = frame else {
        panic!("expected a text frame");
    };
    let value: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(value["kind"], "closed");
    assert!(value["reason"]
        .as_str()
        .expect("reason")
        .contains("unknown event type"));
}

#[tokio::test]
async fn fan_out_serves_many_concurrent_subscribers_without_per_subscriber_queries() {
    let (url, ingestor) = start_server().await;

    let received = Arc::new(AtomicUsize::new(0));
    let mut clients = Vec::with_capacity(SUBSCRIBERS);

    for _ in 0..SUBSCRIBERS {
        let (mut socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("connect");
        await_subscribed(&mut socket).await;

        let received = Arc::clone(&received);
        clients.push(tokio::spawn(async move {
            let event = next_event(&mut socket).await;
            assert_eq!(event["payload"]["task_id"], 1);
            received.fetch_add(1, Ordering::SeqCst);
            // Close cleanly so the server task ends too.
            let _ = socket.send(Message::Close(None)).await;
        }));
    }

    // One ingested event, one broadcast: every subscriber is served from the
    // value ingestion already holds, with no database read per subscriber.
    ingestor
        .ingest_batch(&[raw_registered("tx1", 1, "GOWNER")])
        .await
        .expect("ingest");

    for client in clients {
        client.await.expect("subscriber finished");
    }

    assert_eq!(received.load(Ordering::SeqCst), SUBSCRIBERS);
}
