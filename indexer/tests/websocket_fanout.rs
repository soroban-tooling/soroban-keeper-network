//! End-to-end WebSocket tests against a running server.
//!
//! The unit tests in `api::websocket` cover filtering and payload shape. These
//! exercise the real socket: a live server, real clients, real JSON frames --
//! including the concurrent-subscriber fan-out the design calls for.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use keeper_indexer::api::{router, ApiState};
use keeper_indexer::cache::AggregateCaches;
use keeper_indexer::ingest::Ingestor;
use keeper_indexer::rpc::{RawEvent, RawValue};
use keeper_indexer::store::Store;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// Number of concurrent subscribers the fan-out test attaches.
const SUBSCRIBERS: usize = 50;

/// Start the API on an ephemeral port with a custom WebSocket configuration.
async fn start_server_with_ws_config(
    ws_config: keeper_indexer::api::websocket::WsConfig,
) -> (String, std::net::SocketAddr, Ingestor, ApiState) {
    let store = Store::connect("sqlite::memory:").await.expect("store");
    let ingestor = Ingestor::new(store);
    let state = ApiState {
        ingestor: ingestor.clone(),
        caches: AggregateCaches::from_secs(0),
        progress: keeper_indexer::IngestionProgress::new(),
        max_healthy_lag_ledgers: 60,
        ws_manager: keeper_indexer::api::websocket::WsSessionManager::new(ws_config),
    };
    let app = router(state.clone(), 10_000, 10_000);

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");

    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });

    (format!("ws://{addr}/v1/stream"), addr, ingestor, state)
}

/// Start the API on an ephemeral port, returning its address and the ingestor.
async fn start_server() -> (String, Ingestor) {
    let (url, _addr, ingestor, _state) =
        start_server_with_ws_config(keeper_indexer::api::websocket::WsConfig {
            max_client_connections: 100,
            ..Default::default()
        })
        .await;
    (url, ingestor)
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

#[tokio::test]
async fn connections_above_per_client_cap_are_rejected_before_upgrade() {
    let (url, _addr, _ingestor, state) =
        start_server_with_ws_config(keeper_indexer::api::websocket::WsConfig {
            max_client_connections: 2,
            max_global_connections: 10,
            ..Default::default()
        })
        .await;

    let (mut client1, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("client1 connect");
    await_subscribed(&mut client1).await;

    let (mut client2, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("client2 connect");
    await_subscribed(&mut client2).await;

    assert_eq!(state.ws_manager.active_connections(), 2);

    // Third connection from same client (same IP 127.0.0.1) should be rejected before upgrade with 429
    let err = tokio_tungstenite::connect_async(&url)
        .await
        .expect_err("client3 should be rejected");
    match err {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 429);
        }
        other => panic!("expected HTTP 429 error, got: {other:?}"),
    }

    assert_eq!(state.ws_manager.rejected_connections(), 1);

    // Drop client1, freeing capacity
    drop(client1);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let (mut client3, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("client3 connect after slot freed");
    await_subscribed(&mut client3).await;
    assert_eq!(state.ws_manager.active_connections(), 2);
}

#[tokio::test]
async fn connections_above_global_cap_are_rejected_before_upgrade() {
    let (url, _addr, _ingestor, state) =
        start_server_with_ws_config(keeper_indexer::api::websocket::WsConfig {
            max_client_connections: 10,
            max_global_connections: 1,
            ..Default::default()
        })
        .await;

    let (mut client1, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("client1 connect");
    await_subscribed(&mut client1).await;

    assert_eq!(state.ws_manager.active_connections(), 1);

    // Second connection exceeds global capacity (1) and should be rejected with 429
    let err = tokio_tungstenite::connect_async(&url)
        .await
        .expect_err("client2 should be rejected");
    match err {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 429);
        }
        other => panic!("expected HTTP 429 error, got: {other:?}"),
    }

    assert_eq!(state.ws_manager.rejected_connections(), 1);
}

#[tokio::test]
async fn replay_budget_exhaustion_bounds_history_and_remains_cursor_resumable() {
    let (url, _addr, ingestor, state) =
        start_server_with_ws_config(keeper_indexer::api::websocket::WsConfig {
            max_replay_events: 2,
            ..Default::default()
        })
        .await;

    // Ingest 5 events
    for i in 1..=5u64 {
        ingestor
            .ingest_batch(&[raw_registered(&format!("tx{i}"), i, "GOWNER")])
            .await
            .expect("ingest");
    }

    // Connect asking for events after 0
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("{url}?after=0"))
        .await
        .expect("connect");

    // Client receives first 2 events
    let ev1 = next_event(&mut socket).await;
    assert_eq!(ev1["cursor"], 1);
    let ev2 = next_event(&mut socket).await;
    assert_eq!(ev2["cursor"], 2);

    // Replay budget reached: server sends Closed frame informing client how to resume
    let frame = socket.next().await.expect("frame").expect("no error");
    let Message::Text(text) = frame else {
        panic!("expected text frame");
    };
    let value: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(value["kind"], "closed");
    let reason = value["reason"].as_str().expect("reason");
    assert!(
        reason.contains("replay budget exhausted at cursor 2"),
        "expected replay budget exhausted message, got: {reason}"
    );

    // Client resumes catching up using ?after=2
    let (mut socket2, _) = tokio_tungstenite::connect_async(format!("{url}?after=2"))
        .await
        .expect("connect");

    let ev3 = next_event(&mut socket2).await;
    assert_eq!(ev3["cursor"], 3);
    let ev4 = next_event(&mut socket2).await;
    assert_eq!(ev4["cursor"], 4);

    let frame2 = socket2.next().await.expect("frame").expect("no error");
    let Message::Text(text2) = frame2 else {
        panic!("expected text frame");
    };
    let value2: serde_json::Value = serde_json::from_str(&text2).expect("json");
    assert_eq!(value2["kind"], "closed");
    let reason2 = value2["reason"].as_str().expect("reason");
    assert!(
        reason2.contains("replay budget exhausted at cursor 4"),
        "expected replay budget exhausted message, got: {reason2}"
    );

    // Client resumes catching up using ?after=4
    let (mut socket3, _) = tokio_tungstenite::connect_async(format!("{url}?after=4"))
        .await
        .expect("connect");

    let ev5 = next_event(&mut socket3).await;
    assert_eq!(ev5["cursor"], 5);

    let ack = await_subscribed(&mut socket3).await;
    assert_eq!(ack["replayed_through"], 5);

    assert_eq!(state.ws_manager.replays_completed(), 1);
}

#[tokio::test]
async fn idle_peer_is_disconnected_and_releases_permit() {
    let (url, _addr, _ingestor, state) =
        start_server_with_ws_config(keeper_indexer::api::websocket::WsConfig {
            idle_timeout_secs: 1,
            heartbeat_interval_secs: 1,
            ..Default::default()
        })
        .await;

    let (mut socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("connect");
    await_subscribed(&mut socket).await;
    assert_eq!(state.ws_manager.active_connections(), 1);

    // Wait past the idle timeout without responding
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let mut closed = false;
    while let Some(msg) = socket.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let value: serde_json::Value = serde_json::from_str(&text).expect("json");
                if value["kind"] == "closed" {
                    assert!(value["reason"].as_str().unwrap().contains("idle timeout"));
                    closed = true;
                    break;
                }
            }
            Ok(Message::Close(_)) => {
                closed = true;
                break;
            }
            Ok(Message::Ping(_)) => {
                // Ignore ping frames
            }
            _ => break,
        }
    }
    assert!(closed, "expected socket to be closed due to idle timeout");

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(state.ws_manager.active_connections(), 0);
    assert_eq!(state.ws_manager.idle_disconnects(), 1);
}

#[tokio::test]
async fn operator_metrics_are_exposed_in_health_response() {
    let (url, addr, _ingestor, _state) =
        start_server_with_ws_config(keeper_indexer::api::websocket::WsConfig {
            max_client_connections: 5,
            ..Default::default()
        })
        .await;

    let (mut socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("connect");
    await_subscribed(&mut socket).await;

    let client = reqwest::Client::new();
    let res = client
        .get(format!("http://{addr}/v1/health"))
        .send()
        .await
        .expect("health response");
    assert_eq!(res.status(), 200);

    let body: serde_json::Value = res.json().await.expect("health json");
    assert!(body["ws"].is_object(), "health must expose ws metrics");
    assert_eq!(body["ws"]["active_connections"], 1);
    assert_eq!(body["ws"]["current_clients"], 1);
    assert_eq!(body["ws"]["rejected_connections"], 0);

    drop(socket);
}
