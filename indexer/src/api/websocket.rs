//! Live event subscriptions over WebSocket.
//!
//! A dashboard showing live activity should not poll the REST feed on a timer.
//! This endpoint pushes each event as it is ingested, in the exact shape the
//! REST feed returns, so a client that can already parse a REST event response
//! needs no second parser.
//!
//! Fan-out is one broadcast channel shared by every subscriber, fed by
//! ingestion itself. Delivering an event to N subscribers costs no database
//! query per subscriber -- the event is already in hand when it is broadcast.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use utoipa::ToSchema;

use super::types::ApiError;
use super::ApiState;
use crate::events::{EventType, IndexedEvent};

/// Events replayed per batch when catching a reconnecting client up.
const REPLAY_PAGE_SIZE: u32 = 200;

/// Default configuration constants for WebSocket sessions and replay.
pub const DEFAULT_WS_MAX_GLOBAL_CONNECTIONS: usize = 1_000;
pub const DEFAULT_WS_MAX_CLIENT_CONNECTIONS: usize = 100;
pub const DEFAULT_WS_REPLAY_MAX_EVENTS: usize = 1_000;
pub const DEFAULT_WS_REPLAY_TIMEOUT_SECS: u64 = 15;
pub const DEFAULT_WS_IDLE_TIMEOUT_SECS: u64 = 60;
pub const DEFAULT_WS_HEARTBEAT_INTERVAL_SECS: u64 = 20;

/// Configuration for WebSocket connections, replay limits, and idle timeouts.
#[derive(Debug, Clone)]
pub struct WsConfig {
    pub max_global_connections: usize,
    pub max_client_connections: usize,
    pub max_replay_events: usize,
    pub max_replay_duration: Duration,
    pub idle_timeout: Duration,
    pub heartbeat_interval: Duration,
}

impl Default for WsConfig {
    fn default() -> Self {
        Self {
            max_global_connections: DEFAULT_WS_MAX_GLOBAL_CONNECTIONS,
            max_client_connections: DEFAULT_WS_MAX_CLIENT_CONNECTIONS,
            max_replay_events: DEFAULT_WS_REPLAY_MAX_EVENTS,
            max_replay_duration: Duration::from_secs(DEFAULT_WS_REPLAY_TIMEOUT_SECS),
            idle_timeout: Duration::from_secs(DEFAULT_WS_IDLE_TIMEOUT_SECS),
            heartbeat_interval: Duration::from_secs(DEFAULT_WS_HEARTBEAT_INTERVAL_SECS),
        }
    }
}

/// Operational counters for WebSocket sessions.
#[derive(Debug, Default)]
pub struct WsMetrics {
    pub active_connections: AtomicUsize,
    pub total_connections: AtomicU64,
    pub rejected_global: AtomicU64,
    pub rejected_client: AtomicU64,
    pub replays_completed: AtomicU64,
    pub replays_budget_exhausted: AtomicU64,
    pub idle_disconnects: AtomicU64,
    pub slow_consumer_disconnects: AtomicU64,
}

/// Snapshot of operational metrics for operators and monitoring.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct WsMetricsSnapshot {
    pub active_connections: usize,
    pub total_connections: u64,
    pub rejected_global: u64,
    pub rejected_client: u64,
    pub replays_completed: u64,
    pub replays_budget_exhausted: u64,
    pub idle_disconnects: u64,
    pub slow_consumer_disconnects: u64,
}

impl WsMetrics {
    pub fn snapshot(&self) -> WsMetricsSnapshot {
        WsMetricsSnapshot {
            active_connections: self.active_connections.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
            rejected_global: self.rejected_global.load(Ordering::Relaxed),
            rejected_client: self.rejected_client.load(Ordering::Relaxed),
            replays_completed: self.replays_completed.load(Ordering::Relaxed),
            replays_budget_exhausted: self.replays_budget_exhausted.load(Ordering::Relaxed),
            idle_disconnects: self.idle_disconnects.load(Ordering::Relaxed),
            slow_consumer_disconnects: self.slow_consumer_disconnects.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Default)]
struct WsSessionState {
    active_global: usize,
    active_by_client: HashMap<String, usize>,
}

/// Rejection reason when WebSocket connection capacity is exceeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsRejectReason {
    GlobalLimitReached,
    ClientLimitReached,
}

/// Manages concurrent WebSocket connection permits and metrics.
#[derive(Clone)]
pub struct WsSessionManager {
    config: WsConfig,
    metrics: Arc<WsMetrics>,
    state: Arc<Mutex<WsSessionState>>,
}

impl Default for WsSessionManager {
    fn default() -> Self {
        Self::new(WsConfig::default())
    }
}

impl WsSessionManager {
    pub fn new(config: WsConfig) -> Self {
        Self {
            config,
            metrics: Arc::new(WsMetrics::default()),
            state: Arc::new(Mutex::new(WsSessionState::default())),
        }
    }

    pub fn config(&self) -> &WsConfig {
        &self.config
    }

    pub fn metrics(&self) -> &Arc<WsMetrics> {
        &self.metrics
    }

    pub fn metrics_snapshot(&self) -> WsMetricsSnapshot {
        self.metrics.snapshot()
    }

    /// Try to acquire a connection permit for `client`.
    pub fn try_acquire(&self, client: &str) -> Result<WsPermit, WsRejectReason> {
        let mut state = self.state.lock().expect("ws session mutex poisoned");
        if state.active_global >= self.config.max_global_connections {
            self.metrics.rejected_global.fetch_add(1, Ordering::Relaxed);
            return Err(WsRejectReason::GlobalLimitReached);
        }
        let client_count = state.active_by_client.get(client).copied().unwrap_or(0);
        if client_count >= self.config.max_client_connections {
            self.metrics.rejected_client.fetch_add(1, Ordering::Relaxed);
            return Err(WsRejectReason::ClientLimitReached);
        }

        state.active_global += 1;
        *state
            .active_by_client
            .entry(client.to_string())
            .or_default() += 1;
        self.metrics
            .active_connections
            .fetch_add(1, Ordering::Relaxed);
        self.metrics
            .total_connections
            .fetch_add(1, Ordering::Relaxed);

        Ok(WsPermit {
            client: client.to_string(),
            state: Arc::downgrade(&self.state),
            metrics: Arc::clone(&self.metrics),
        })
    }
}

/// RAII permit for a live WebSocket connection.
///
/// Ensures capacity is released on every close/error/panic path.
pub struct WsPermit {
    client: String,
    state: std::sync::Weak<Mutex<WsSessionState>>,
    metrics: Arc<WsMetrics>,
}

impl Drop for WsPermit {
    fn drop(&mut self) {
        if let Some(state_arc) = self.state.upgrade() {
            let mut state = state_arc.lock().expect("ws session mutex poisoned");
            state.active_global = state.active_global.saturating_sub(1);
            if let Some(count) = state.active_by_client.get_mut(&self.client) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    state.active_by_client.remove(&self.client);
                }
            }
            self.metrics
                .active_connections
                .fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// Identify the client from `X-API-Key` or IP address.
fn client_key(headers: &HeaderMap, addr: Option<SocketAddr>) -> String {
    if let Some(key) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        if !key.trim().is_empty() {
            return format!("key:{}", key.trim());
        }
    }
    match addr {
        Some(addr) => format!("ip:{}", addr.ip()),
        None => "unknown".to_string(),
    }
}

/// Subscription filters, given as query parameters on the upgrade request.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SubscribeQuery {
    /// Only events of this type, by its wire name.
    pub event_type: Option<String>,
    /// Only events mentioning this address, as owner or keeper.
    pub address: Option<String>,
    /// Resume from this cursor, replaying anything missed first.
    pub after: Option<i64>,
}

/// What the server sends over the socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent once, after any replay, when the live feed is attached.
    Subscribed {
        event_type: Option<String>,
        address: Option<String>,
        /// Cursor the live feed resumes from, if a replay happened.
        replayed_through: Option<i64>,
    },
    /// One ingested event, identical to the REST feed's shape.
    Event { event: IndexedEvent },
    /// The subscription is being closed, with the reason why.
    Closed { reason: String },
}

/// The filters one subscriber applied.
#[derive(Debug, Clone, Default)]
struct Filter {
    event_type: Option<EventType>,
    address: Option<String>,
}

impl Filter {
    fn matches(&self, event: &IndexedEvent) -> bool {
        if let Some(wanted) = self.event_type {
            if event.event_type != wanted {
                return false;
            }
        }
        if let Some(address) = &self.address {
            let owner = event.payload.owner();
            let keeper = event.payload.keeper();
            if owner != Some(address.as_str()) && keeper != Some(address.as_str()) {
                return false;
            }
        }
        true
    }
}

/// Upgrade an HTTP request to a live event subscription, enforcing connection caps before upgrade.
pub async fn subscribe(
    State(state): State<ApiState>,
    headers: HeaderMap,
    addr: Option<ConnectInfo<SocketAddr>>,
    Query(query): Query<SubscribeQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let client_id = client_key(&headers, addr.map(|ConnectInfo(a)| a));
    let permit = match state.ws_manager.try_acquire(&client_id) {
        Ok(permit) => permit,
        Err(WsRejectReason::GlobalLimitReached) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ApiError::new(
                    "global_ws_connection_limit_reached",
                    "global concurrent websocket connection limit reached",
                )),
            )
                .into_response();
        }
        Err(WsRejectReason::ClientLimitReached) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ApiError::new(
                    "client_ws_connection_limit_reached",
                    "per-client concurrent websocket connection limit reached",
                )),
            )
                .into_response();
        }
    };

    upgrade.on_upgrade(move |socket| handle_socket(socket, state, query, permit))
}

async fn handle_socket(
    socket: WebSocket,
    state: ApiState,
    query: SubscribeQuery,
    _permit: WsPermit,
) {
    let live = state.ingestor.subscribe();

    let event_type = match query.event_type.as_deref() {
        None => None,
        Some(name) => match EventType::parse(name) {
            Some(ty) => Some(ty),
            None => {
                close_with(socket, format!("unknown event type: {name}")).await;
                return;
            }
        },
    };

    let filter = Filter {
        event_type,
        address: query
            .address
            .clone()
            .map(|address| crate::address::normalize_address(&address).unwrap_or(address)),
    };

    let (mut sink, mut incoming) = socket.split();

    // Replay anything the client missed while disconnected, bounded by event count and time.
    let mut replayed_through = None;
    if let Some(after) = query.after {
        let mut cursor = after;
        let mut total_replayed = 0;
        let replay_start = Instant::now();
        let mut budget_exhausted = false;

        loop {
            if replay_start.elapsed() >= state.ws_manager.config.max_replay_duration {
                budget_exhausted = true;
                break;
            }

            let remaining = state
                .ws_manager
                .config
                .max_replay_events
                .saturating_sub(total_replayed);
            if remaining == 0 {
                budget_exhausted = true;
                break;
            }
            let batch_limit = (remaining as u32).min(REPLAY_PAGE_SIZE);

            let page = match state
                .ingestor
                .store()
                .events_after(
                    Some(cursor),
                    batch_limit,
                    filter.event_type,
                    filter.address.as_deref(),
                )
                .await
            {
                Ok(page) => page,
                Err(err) => {
                    tracing::error!(error = %err, "replay failed");
                    break;
                }
            };

            if page.events.is_empty() {
                break;
            }

            for event in &page.events {
                cursor = event.cursor;
                total_replayed += 1;
                if send(
                    &mut sink,
                    &ServerMessage::Event {
                        event: event.clone(),
                    },
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            replayed_through = Some(cursor);

            if page.next_cursor.is_none() {
                break;
            }

            if total_replayed >= state.ws_manager.config.max_replay_events {
                budget_exhausted = true;
                break;
            }
        }

        if budget_exhausted {
            state
                .ws_manager
                .metrics
                .replays_budget_exhausted
                .fetch_add(1, Ordering::Relaxed);
            let _ = send(
                &mut sink,
                &ServerMessage::Closed {
                    reason: format!(
                        "replay budget exhausted at cursor {cursor}; reconnect with ?after={cursor}"
                    ),
                },
            )
            .await;
            return;
        }

        state
            .ws_manager
            .metrics
            .replays_completed
            .fetch_add(1, Ordering::Relaxed);
    }

    if send(
        &mut sink,
        &ServerMessage::Subscribed {
            event_type: query.event_type.clone(),
            address: filter.address.clone(),
            replayed_through,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let mut live = live;
    let mut heartbeat_interval = tokio::time::interval(state.ws_manager.config.heartbeat_interval);
    heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_activity = Instant::now();

    loop {
        tokio::select! {
            _ = heartbeat_interval.tick() => {
                if last_activity.elapsed() >= state.ws_manager.config.idle_timeout {
                    state.ws_manager.metrics.idle_disconnects.fetch_add(1, Ordering::Relaxed);
                    let _ = send(
                        &mut sink,
                        &ServerMessage::Closed {
                            reason: "idle timeout: connection closed due to inactivity".into(),
                        },
                    )
                    .await;
                    break;
                }
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            incoming = incoming.next() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(Message::Pong(_)))
                | Some(Ok(Message::Ping(_)))
                | Some(Ok(Message::Text(_)))
                | Some(Ok(Message::Binary(_))) => {
                    last_activity = Instant::now();
                    continue;
                }
            },
            received = live.recv() => match received {
                Ok(event) => {
                    if replayed_through.is_some_and(|through| event.cursor <= through) {
                        continue;
                    }
                    if !filter.matches(&event) {
                        continue;
                    }
                    if send(&mut sink, &ServerMessage::Event { event }).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(missed)) => {
                    state.ws_manager.metrics.slow_consumer_disconnects.fetch_add(1, Ordering::Relaxed);
                    let _ = send(
                        &mut sink,
                        &ServerMessage::Closed {
                            reason: format!(
                                "subscriber fell {missed} events behind; reconnect with ?after=<last cursor>"
                            ),
                        },
                    )
                    .await;
                    break;
                }
                Err(RecvError::Closed) => break,
            }
        }
    }
}

async fn send<S>(sink: &mut S, message: &ServerMessage) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    let encoded = match serde_json::to_string(message) {
        Ok(encoded) => encoded,
        Err(err) => {
            tracing::error!(error = %err, "encoding a server message failed");
            return Err(());
        }
    };
    sink.send(Message::Text(encoded.into()))
        .await
        .map_err(|_| ())
}

async fn close_with(socket: WebSocket, reason: String) {
    let (mut sink, _) = socket.split();
    let _ = send(&mut sink, &ServerMessage::Closed { reason }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventPayload, I128};
    use crate::ingest::Ingestor;
    use crate::rpc::{RawEvent, RawValue};
    use crate::store::Store;

    fn registered(task_id: u64, owner: &str) -> EventPayload {
        EventPayload::TaskRegistered {
            task_id,
            owner: owner.into(),
            reward: I128(100),
            deadline: 900,
        }
    }

    fn executed(task_id: u64, keeper: &str) -> EventPayload {
        EventPayload::TaskExecuted {
            task_id,
            keeper: keeper.into(),
            net_reward: I128(90),
            proof: "00".into(),
        }
    }

    fn indexed(cursor: i64, payload: EventPayload) -> IndexedEvent {
        IndexedEvent {
            cursor,
            ledger: 10,
            ledger_close_time: 100,
            tx_hash: format!("tx{cursor}"),
            event_index: 0,
            event_type: payload.event_type(),
            payload,
        }
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

    #[test]
    fn an_empty_filter_accepts_every_event() {
        let filter = Filter::default();
        assert!(filter.matches(&indexed(1, registered(1, "GOWNER"))));
        assert!(filter.matches(&indexed(2, executed(1, "GKEEPER"))));
    }

    #[test]
    fn filtering_by_event_type_excludes_other_types() {
        let filter = Filter {
            event_type: Some(EventType::TaskExecuted),
            address: None,
        };
        assert!(!filter.matches(&indexed(1, registered(1, "GOWNER"))));
        assert!(filter.matches(&indexed(2, executed(1, "GKEEPER"))));
    }

    #[test]
    fn filtering_by_address_matches_owner_or_keeper() {
        let owner_filter = Filter {
            event_type: None,
            address: Some("GOWNER".into()),
        };
        assert!(owner_filter.matches(&indexed(1, registered(1, "GOWNER"))));
        assert!(!owner_filter.matches(&indexed(2, executed(1, "GKEEPER"))));

        let keeper_filter = Filter {
            event_type: None,
            address: Some("GKEEPER".into()),
        };
        assert!(keeper_filter.matches(&indexed(2, executed(1, "GKEEPER"))));
        assert!(!keeper_filter.matches(&indexed(1, registered(1, "GOWNER"))));
    }

    #[test]
    fn type_and_address_filters_combine() {
        let filter = Filter {
            event_type: Some(EventType::TaskExecuted),
            address: Some("GKEEPER".into()),
        };
        assert!(filter.matches(&indexed(1, executed(1, "GKEEPER"))));
        // Right type, wrong keeper.
        assert!(!filter.matches(&indexed(2, executed(2, "GOTHER"))));
        // Right address, wrong type.
        assert!(!filter.matches(&indexed(3, registered(3, "GKEEPER"))));
    }

    #[test]
    fn a_pushed_event_serialises_exactly_like_the_rest_feed() {
        let event = indexed(7, executed(1, "GKEEPER"));

        // The REST feed serialises IndexedEvent directly; the socket wraps the
        // same value. Unwrapping the envelope must yield byte-identical JSON,
        // so one parser serves both feeds.
        let rest = serde_json::to_value(&event).expect("rest shape");
        let pushed = serde_json::to_value(ServerMessage::Event {
            event: event.clone(),
        })
        .expect("socket shape");

        assert_eq!(pushed["kind"], "event");
        assert_eq!(pushed["event"], rest);
    }

    #[tokio::test]
    async fn ingestion_broadcasts_to_every_subscriber_from_one_channel() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let ingestor = Ingestor::new(store);

        // Many subscribers, one broadcast: no per-subscriber query is issued,
        // because each receives the event value ingestion already holds.
        let mut subscribers: Vec<_> = (0..64).map(|_| ingestor.subscribe()).collect();

        ingestor
            .ingest_batch(&[raw_registered("tx1", 1, "GOWNER")])
            .await
            .expect("ingest");

        for subscriber in &mut subscribers {
            let event = subscriber
                .try_recv()
                .expect("each subscriber got the event");
            assert_eq!(event.payload.task_id(), Some(1));
        }
    }

    #[tokio::test]
    async fn a_subscriber_that_joins_late_sees_only_later_events() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let ingestor = Ingestor::new(store);

        ingestor
            .ingest_batch(&[raw_registered("tx-early", 1, "GOWNER")])
            .await
            .expect("ingest");

        let mut late = ingestor.subscribe();
        ingestor
            .ingest_batch(&[raw_registered("tx-late", 2, "GOWNER")])
            .await
            .expect("ingest");

        let event = late.try_recv().expect("the later event");
        assert_eq!(event.payload.task_id(), Some(2));
        // The earlier event is not replayed on the live channel; that is what
        // the ?after= cursor replay is for.
        assert!(late.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_reconnecting_client_can_replay_from_its_last_cursor() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let ingestor = Ingestor::new(store);

        for i in 0..5u64 {
            ingestor
                .ingest_batch(&[raw_registered(&format!("tx{i}"), i, "GOWNER")])
                .await
                .expect("ingest");
        }

        // The client saw up to cursor 2 before dropping; reconnecting with
        // that cursor yields exactly what it missed, in order.
        let missed = ingestor
            .store()
            .events_after(Some(2), REPLAY_PAGE_SIZE, None, None)
            .await
            .expect("replay");

        assert_eq!(missed.events.len(), 3);
        assert!(missed.events.iter().all(|e| e.cursor > 2));
    }

    #[tokio::test]
    async fn replay_honours_the_same_filters_as_the_live_feed() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let ingestor = Ingestor::new(store);

        ingestor
            .ingest_batch(&[raw_registered("tx1", 1, "GOWNER")])
            .await
            .expect("ingest");
        ingestor
            .store()
            .insert_event(11, 110, "tx2", 0, &executed(1, "GKEEPER"))
            .await
            .expect("insert");

        let replay = ingestor
            .store()
            .events_after(
                Some(0),
                REPLAY_PAGE_SIZE,
                Some(EventType::TaskExecuted),
                None,
            )
            .await
            .expect("replay");

        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].event_type, EventType::TaskExecuted);
    }

    #[test]
    fn a_lagged_subscriber_is_told_how_to_resume() {
        let message = ServerMessage::Closed {
            reason: "subscriber fell 12 events behind; reconnect with ?after=<last cursor>"
                .to_string(),
        };
        let json = serde_json::to_value(&message).expect("serialises");
        assert_eq!(json["kind"], "closed");
        assert!(json["reason"].as_str().expect("reason").contains("after="));
    }

    #[test]
    fn session_manager_enforces_per_client_limit_and_records_metrics() {
        let config = WsConfig {
            max_client_connections: 2,
            max_global_connections: 10,
            ..Default::default()
        };
        let manager = WsSessionManager::new(config);

        let p1 = manager.try_acquire("ip:127.0.0.1").expect("p1");
        let p2 = manager.try_acquire("ip:127.0.0.1").expect("p2");
        assert_eq!(manager.metrics_snapshot().active_connections, 2);

        // Third attempt for the same client must be rejected with ClientLimitReached
        let err = manager
            .try_acquire("ip:127.0.0.1")
            .expect_err("should reject");
        assert_eq!(err, WsRejectReason::ClientLimitReached);
        assert_eq!(manager.metrics_snapshot().rejected_client, 1);

        // Another client is not affected
        let other = manager.try_acquire("ip:10.0.0.1").expect("other client");
        assert_eq!(manager.metrics_snapshot().active_connections, 3);

        // Dropping p1 releases capacity
        drop(p1);
        assert_eq!(manager.metrics_snapshot().active_connections, 2);
        let p3 = manager.try_acquire("ip:127.0.0.1").expect("p3 re-acquire");
        assert_eq!(manager.metrics_snapshot().active_connections, 3);

        drop(p2);
        drop(p3);
        drop(other);
        assert_eq!(manager.metrics_snapshot().active_connections, 0);
    }

    #[test]
    fn session_manager_enforces_global_limit_and_records_metrics() {
        let config = WsConfig {
            max_global_connections: 2,
            max_client_connections: 5,
            ..Default::default()
        };
        let manager = WsSessionManager::new(config);

        let p1 = manager.try_acquire("client1").expect("p1");
        let p2 = manager.try_acquire("client2").expect("p2");
        assert_eq!(manager.metrics_snapshot().active_connections, 2);

        // Third attempt globally must be rejected with GlobalLimitReached
        let err = manager.try_acquire("client3").expect_err("should reject");
        assert_eq!(err, WsRejectReason::GlobalLimitReached);
        assert_eq!(manager.metrics_snapshot().rejected_global, 1);

        drop(p1);
        let p3 = manager.try_acquire("client3").expect("p3 after drop");
        assert_eq!(manager.metrics_snapshot().active_connections, 2);

        drop(p2);
        drop(p3);
        assert_eq!(manager.metrics_snapshot().active_connections, 0);
    }

    #[test]
    fn session_manager_handles_permit_churn_cleanly() {
        let manager = WsSessionManager::default();
        for i in 0..100 {
            let client = format!("client_{}", i % 5);
            let permit = manager.try_acquire(&client).expect("permit");
            assert!(manager.metrics_snapshot().active_connections > 0);
            drop(permit);
        }
        assert_eq!(manager.metrics_snapshot().active_connections, 0);
        assert_eq!(manager.metrics_snapshot().total_connections, 100);
    }

    #[test]
    fn replay_budget_exhaustion_formats_resumable_reason() {
        let cursor = 42;
        let reason =
            format!("replay budget exhausted at cursor {cursor}; reconnect with ?after={cursor}");
        let message = ServerMessage::Closed { reason };
        let json = serde_json::to_value(&message).expect("serialises");
        assert_eq!(json["kind"], "closed");
        assert!(json["reason"]
            .as_str()
            .expect("reason")
            .contains("after=42"));
    }
}
