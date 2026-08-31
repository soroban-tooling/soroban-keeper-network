//! Applying decoded events to the database.
//!
//! Split by the audience each group of events serves rather than by contract
//! module: [`keepers`] answers "what has this keeper done", [`admin`] holds the
//! governance audit trail. Each module takes the whole event stream and ignores
//! what it does not own, so adding a group does not require the caller to learn
//! a new routing rule.

pub mod admin;
pub mod keepers;
pub mod tasks;
//! Per-event parsing and ingestion.
//!
//! This is the single path from a raw RPC event to a stored row. Backfill and
//! steady-state polling both call [`Ingestor::ingest_batch`]; neither has a
//! parser of its own, so the two cannot drift as the event set evolves. The
//! only thing that differs between them is the ledger range being walked.

pub mod parse;

use anyhow::Result;
use tokio::sync::broadcast;

use crate::events::IndexedEvent;
use crate::rpc::RawEvent;
use crate::store::Store;

/// Capacity of the live-event broadcast channel.
///
/// Sized so a subscriber briefly blocked on a slow socket does not miss
/// events; one that falls further behind than this is disconnected rather
/// than allowed to stall ingestion.
const BROADCAST_CAPACITY: usize = 1_024;

/// Turns raw RPC events into stored, broadcast events.
#[derive(Clone)]
pub struct Ingestor {
    store: Store,
    live: broadcast::Sender<IndexedEvent>,
}

/// What one call to [`Ingestor::ingest_batch`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IngestOutcome {
    /// Events stored for the first time.
    pub stored: usize,
    /// Events already present, skipped idempotently.
    pub duplicates: usize,
    /// Events whose topic pair the contract does not emit.
    pub unrecognised: usize,
}

impl Ingestor {
    /// Build an ingestor over `store`.
    pub fn new(store: Store) -> Self {
        let (live, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self { store, live }
    }

    /// Subscribe to events as they are ingested.
    ///
    /// Every subscriber receives from this one channel, so fan-out costs no
    /// database query per subscriber per event.
    pub fn subscribe(&self) -> broadcast::Receiver<IndexedEvent> {
        self.live.subscribe()
    }

    /// The store behind this ingestor.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Parse and store a batch of raw events, in order.
    ///
    /// An event whose topics the contract does not emit is counted and
    /// skipped: a future contract version emitting something new must not stop
    /// ingestion of the events this indexer does understand.
    pub async fn ingest_batch(&self, raw: &[RawEvent]) -> Result<IngestOutcome> {
        let mut outcome = IngestOutcome::default();

        for event in raw {
            let Some(payload) = parse::parse_event(event)? else {
                outcome.unrecognised += 1;
                continue;
            };

            let stored = self
                .store
                .insert_event(
                    event.ledger,
                    event.ledger_close_time,
                    &event.tx_hash,
                    event.event_index,
                    &payload,
                )
                .await?;

            match stored {
                Some(indexed) => {
                    outcome.stored += 1;
                    // A send error only means nobody is listening, which is
                    // normal when no dashboard is connected.
                    let _ = self.live.send(indexed);
                }
                None => outcome.duplicates += 1,
            }
        }

        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventType, I128};
    use crate::rpc::RawValue;

    async fn ingestor() -> Ingestor {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        Ingestor::new(store)
    }

    fn registered_event(tx: &str, task_id: u64) -> RawEvent {
        RawEvent {
            ledger: 10,
            ledger_close_time: 100,
            tx_hash: tx.to_string(),
            event_index: 0,
            topics: vec!["reg".into(), "task".into()],
            values: vec![
                RawValue::U64(task_id),
                RawValue::Address("GOWNER".into()),
                RawValue::I128(500),
                RawValue::U64(9_000),
            ],
        }
    }

    #[tokio::test]
    async fn a_batch_is_parsed_stored_and_counted() {
        let ingestor = ingestor().await;
        let outcome = ingestor
            .ingest_batch(&[registered_event("tx1", 1), registered_event("tx2", 2)])
            .await
            .expect("ingest");

        assert_eq!(outcome.stored, 2);
        assert_eq!(outcome.duplicates, 0);
    }

    #[tokio::test]
    async fn re_ingesting_a_ledger_stores_nothing_twice() {
        let ingestor = ingestor().await;
        let batch = [registered_event("tx1", 1)];

        assert_eq!(
            ingestor.ingest_batch(&batch).await.expect("first").stored,
            1
        );
        let second = ingestor.ingest_batch(&batch).await.expect("second");
        assert_eq!(second.stored, 0);
        assert_eq!(second.duplicates, 1);
    }

    #[tokio::test]
    async fn an_unknown_topic_pair_is_skipped_not_fatal() {
        let ingestor = ingestor().await;
        let mut unknown = registered_event("tx-unknown", 1);
        unknown.topics = vec!["future".into(), "event".into()];

        let outcome = ingestor
            .ingest_batch(&[unknown, registered_event("tx-known", 2)])
            .await
            .expect("ingest continues past the unknown event");

        assert_eq!(outcome.unrecognised, 1);
        assert_eq!(outcome.stored, 1);
    }

    #[tokio::test]
    async fn subscribers_receive_each_newly_stored_event() {
        let ingestor = ingestor().await;
        let mut feed = ingestor.subscribe();

        ingestor
            .ingest_batch(&[registered_event("tx1", 7)])
            .await
            .expect("ingest");

        let received = feed.try_recv().expect("event was broadcast");
        assert_eq!(received.event_type, EventType::TaskRegistered);
        assert_eq!(received.payload.task_id(), Some(7));
    }

    #[tokio::test]
    async fn a_duplicate_is_not_broadcast_a_second_time() {
        let ingestor = ingestor().await;
        let batch = [registered_event("tx1", 1)];
        ingestor.ingest_batch(&batch).await.expect("first");

        let mut feed = ingestor.subscribe();
        ingestor.ingest_batch(&batch).await.expect("second");

        // Subscribing after the first ingest, the duplicate must produce
        // nothing: a reconnecting dashboard should not see phantom activity.
        assert!(feed.try_recv().is_err());
    }

    #[tokio::test]
    async fn parsed_payload_matches_the_contract_field_order() {
        let ingestor = ingestor().await;
        ingestor
            .ingest_batch(&[registered_event("tx1", 42)])
            .await
            .expect("ingest");

        let state = ingestor
            .store()
            .task_state(42)
            .await
            .expect("query")
            .expect("task exists");
        assert_eq!(state.owner, "GOWNER");
        assert_eq!(state.reward, I128(500));
        assert_eq!(state.deadline, 9_000);
    }
}
