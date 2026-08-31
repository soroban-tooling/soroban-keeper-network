//! The Soroban RPC surface the indexer depends on.
//!
//! Ingestion is defined against the [`EventSource`] trait rather than a
//! concrete HTTP client, so backfill and steady-state polling can both be
//! tested deterministically against a fixture source. The design document
//! chose polling `getEvents` -- the same mechanism the keeper-bot already
//! uses -- over a streaming subscription, because no Soroban RPC provider
//! offers a durable stream that survives a reconnect without replay anyway.

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// A scalar in an event payload, in the shapes the registry actually emits.
///
/// This is deliberately not a general XDR value type: the contract emits only
/// these six, and a narrow enum makes a payload-shape change a compile error
/// in `parse.rs` rather than a runtime surprise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RawValue {
    U32(u32),
    U64(u64),
    I128(i128),
    Bool(bool),
    /// Stellar strkey address.
    Address(String),
    /// Hex-encoded bytes.
    Bytes(String),
}

/// One event as the RPC returns it, before typed parsing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvent {
    pub ledger: u32,
    pub ledger_close_time: i64,
    pub tx_hash: String,
    pub event_index: u32,
    /// The `(verb, noun)` topic pair, as symbols.
    pub topics: Vec<String>,
    /// Payload fields, in the order the contract published them.
    pub values: Vec<RawValue>,
}

/// One page of events from a ledger range.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventPage {
    pub events: Vec<RawEvent>,
    /// Highest ledger this page covers; ingestion checkpoints on it.
    pub latest_ledger_scanned: u32,
}

/// A source of contract events over a ledger range.
#[allow(async_fn_in_trait)]
pub trait EventSource {
    /// Fetch events for `contract_id` in `[start_ledger, start_ledger + limit)`.
    async fn get_events(
        &self,
        contract_id: &str,
        start_ledger: u32,
        limit: u32,
    ) -> Result<EventPage>;

    /// The current chain tip, so backfill knows when it has caught up.
    async fn latest_ledger(&self) -> Result<u32>;
}

#[cfg(test)]
pub mod fixture {
    //! An in-memory [`EventSource`] for deterministic tests.

    use super::*;
    use std::sync::{Arc, Mutex};

    /// A fixed set of events, served by ledger range.
    #[derive(Clone, Default)]
    pub struct FixtureSource {
        events: Vec<RawEvent>,
        tip: u32,
        /// Ledger at which the next `get_events` call fails, simulating an
        /// interrupted backfill.
        fail_at: Arc<Mutex<Option<u32>>>,
        /// Number of `get_events` calls served, for asserting page counts.
        calls: Arc<Mutex<usize>>,
    }

    impl FixtureSource {
        pub fn new(events: Vec<RawEvent>, tip: u32) -> Self {
            Self {
                events,
                tip,
                fail_at: Arc::new(Mutex::new(None)),
                calls: Arc::new(Mutex::new(0)),
            }
        }

        /// Make the next request covering `ledger` fail once.
        pub fn fail_once_at(&self, ledger: u32) {
            *self.fail_at.lock().expect("fixture lock") = Some(ledger);
        }

        pub fn call_count(&self) -> usize {
            *self.calls.lock().expect("fixture lock")
        }
    }

    impl EventSource for FixtureSource {
        async fn get_events(
            &self,
            _contract_id: &str,
            start_ledger: u32,
            limit: u32,
        ) -> Result<EventPage> {
            *self.calls.lock().expect("fixture lock") += 1;

            let end = start_ledger.saturating_add(limit);
            {
                let mut fail_at = self.fail_at.lock().expect("fixture lock");
                if let Some(ledger) = *fail_at {
                    if ledger >= start_ledger && ledger < end {
                        *fail_at = None;
                        anyhow::bail!("simulated RPC failure at ledger {ledger}");
                    }
                }
            }

            let events: Vec<RawEvent> = self
                .events
                .iter()
                .filter(|e| e.ledger >= start_ledger && e.ledger < end)
                .cloned()
                .collect();

            Ok(EventPage {
                events,
                latest_ledger_scanned: end.saturating_sub(1).min(self.tip),
            })
        }

        async fn latest_ledger(&self) -> Result<u32> {
            Ok(self.tip)
        }
    }
}
