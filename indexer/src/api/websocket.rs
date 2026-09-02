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

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;

use super::ApiState;
use crate::events::{EventType, IndexedEvent};

/// Events replayed per batch when catching a reconnecting client up.
const REPLAY_PAGE_SIZE: u32 = 200;

/// Subscription filters, given as query parameters on the upgrade request.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SubscribeQuery {
    /// Only events of this type, by its wire name.
    pub event_type: Option<String>,
    /// Only events mentioning this address, as owner or keeper.
    pub address: Option<String>,
    /// Resume from this cursor, replaying anything missed first.
    ///
    /// A client that drops its connection reconnects with the last cursor it
    /// saw, so a brief network interruption does not silently lose events.
    pub after: Option<i64>,
}

/// What the server sends over the socket.
///
/// The `event` variant wraps the same [`IndexedEvent`] the REST feed returns,
/// rather than a parallel WebSocket-specific shape.
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
    /// Whether this subscriber wants `event`.
    ///
    /// Matching happens in memory against the already-broadcast event, so a
    /// filtered subscription costs no extra query either.
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

/// Upgrade an HTTP request to a live event subscription.
pub async fn subscribe(
    State(state): State<ApiState>,
    Query(query): Query<SubscribeQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| handle_socket(socket, state, query))
}

async fn handle_socket(socket: WebSocket, state: ApiState, query: SubscribeQuery) {
    // Subscribe before replaying: an event ingested during the replay is then
    // buffered on the channel rather than falling into the gap between the
    // replay's last row and the live feed's first.
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
        address: query.address.clone(),
    };

    let (mut sink, mut incoming) = socket.split();

    // Replay anything the client missed while disconnected.
    let mut replayed_through = None;
    if let Some(after) = query.after {
        let mut cursor = after;
        loop {
            let page = match state
                .ingestor
                .store()
                .events_after(
                    Some(cursor),
                    REPLAY_PAGE_SIZE,
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
        }
    }

    if send(
        &mut sink,
        &ServerMessage::Subscribed {
            event_type: query.event_type.clone(),
            address: query.address.clone(),
            replayed_through,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    let mut live = live;
    loop {
        tokio::select! {
            // A client that closes the socket ends the subscription.
            incoming = incoming.next() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => continue,
            },
            received = live.recv() => match received {
                Ok(event) => {
                    // An event already replayed above must not be sent twice.
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
                // A subscriber too slow to keep up is disconnected rather than
                // allowed to stall ingestion for everyone else. It reconnects
                // with its last cursor and replays what it missed.
                Err(RecvError::Lagged(missed)) => {
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
            },
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
}
