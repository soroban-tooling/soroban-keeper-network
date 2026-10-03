//! Shared ingestion-progress state, for the lag metric (issue #359).
//!
//! A consumer relying on the indexer for near-real-time data needs to know
//! how far behind the chain it currently is: from the outside, a stalled
//! indexer looks identical to a healthy but quiet one. The backfiller
//! records what it learns on every ingestion cycle — the chain tip it read,
//! the ledger it has fully ingested through — and the API's health check
//! reads the difference without touching the database.
//!
//! The handle is `Clone` over shared atomics: the ingestion loop writes,
//! any number of health checks read, nobody blocks anybody.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

/// The sentinel meaning "not observed yet". Ledger sequence 0 does not occur
/// in practice (Stellar's genesis ledger is 1), so 0 is free to mean absent —
/// which keeps the whole struct lock-free instead of an `Option` behind a
/// mutex.
const UNOBSERVED: u32 = 0;

#[derive(Debug, Default)]
struct Inner {
    /// Highest chain tip any ingestion cycle has observed.
    latest_known_ledger: AtomicU32,
    /// Highest ledger fully ingested (checkpointed through).
    last_ingested_ledger: AtomicU32,
    /// Ingestion cycles completed, so a frozen loop is distinguishable from
    /// one that never started.
    cycles: AtomicU64,
}

/// What ingestion has observed so far. See [`IngestionProgress::snapshot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressSnapshot {
    /// Highest chain tip observed, absent before the first cycle.
    pub latest_known_ledger: Option<u32>,
    /// Highest ledger fully ingested, absent before the first checkpoint.
    pub last_ingested_ledger: Option<u32>,
    /// Completed ingestion cycles.
    pub cycles: u64,
}

impl ProgressSnapshot {
    /// How many ledgers ingestion is behind the chain, in ledgers.
    ///
    /// `None` until both sides have been observed — reporting `0` before the
    /// first cycle would make a not-yet-started indexer look caught up, which
    /// is exactly the confusion the metric exists to remove.
    pub fn lag_ledgers(&self) -> Option<u32> {
        let tip = self.latest_known_ledger?;
        let ingested = self.last_ingested_ledger?;
        Some(tip.saturating_sub(ingested))
    }
}

/// Cloneable handle to the shared progress state.
#[derive(Debug, Clone, Default)]
pub struct IngestionProgress {
    inner: Arc<Inner>,
}

impl IngestionProgress {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the chain tip an ingestion cycle just read.
    ///
    /// Monotonic: an RPC node answering from behind a load balancer can
    /// report a tip lower than one already seen, and the metric must not
    /// jitter backwards over it.
    pub fn observe_tip(&self, tip: u32) {
        self.inner
            .latest_known_ledger
            .fetch_max(tip, Ordering::Relaxed);
    }

    /// Record that ingestion has fully processed through `ledger`.
    pub fn observe_ingested(&self, ledger: u32) {
        self.inner
            .last_ingested_ledger
            .fetch_max(ledger, Ordering::Relaxed);
    }

    /// Record a completed ingestion cycle.
    pub fn observe_cycle(&self) {
        self.inner.cycles.fetch_add(1, Ordering::Relaxed);
    }

    /// A consistent-enough view for a health check.
    pub fn snapshot(&self) -> ProgressSnapshot {
        let read = |a: &AtomicU32| match a.load(Ordering::Relaxed) {
            UNOBSERVED => None,
            v => Some(v),
        };
        ProgressSnapshot {
            latest_known_ledger: read(&self.inner.latest_known_ledger),
            last_ingested_ledger: read(&self.inner.last_ingested_ledger),
            cycles: self.inner.cycles.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lag_is_unknown_until_both_sides_are_observed() {
        let progress = IngestionProgress::new();
        assert_eq!(progress.snapshot().lag_ledgers(), None);

        progress.observe_tip(100);
        assert_eq!(progress.snapshot().lag_ledgers(), None);

        progress.observe_ingested(90);
        assert_eq!(progress.snapshot().lag_ledgers(), Some(10));
    }

    #[test]
    fn lag_grows_while_ingestion_stalls_and_the_tip_advances() {
        let progress = IngestionProgress::new();
        progress.observe_tip(100);
        progress.observe_ingested(100);
        assert_eq!(progress.snapshot().lag_ledgers(), Some(0));

        // The stall: the chain keeps moving, ingestion does not.
        for tip in [110, 130, 175] {
            progress.observe_tip(tip);
        }
        assert_eq!(progress.snapshot().lag_ledgers(), Some(75));
    }

    #[test]
    fn a_lagging_rpc_answer_cannot_move_the_metric_backwards() {
        let progress = IngestionProgress::new();
        progress.observe_tip(200);
        progress.observe_tip(150); // load-balanced node answering from behind
        progress.observe_ingested(150);
        assert_eq!(progress.snapshot().lag_ledgers(), Some(50));
    }

    #[test]
    fn caught_up_ingestion_reports_zero_lag_not_underflow() {
        let progress = IngestionProgress::new();
        progress.observe_tip(100);
        // Ingested past the last observed tip (the tip read raced the walk).
        progress.observe_ingested(103);
        assert_eq!(progress.snapshot().lag_ledgers(), Some(0));
    }

    #[test]
    fn cycles_distinguish_a_frozen_loop_from_one_that_never_started() {
        let progress = IngestionProgress::new();
        assert_eq!(progress.snapshot().cycles, 0);
        progress.observe_cycle();
        progress.observe_cycle();
        assert_eq!(progress.snapshot().cycles, 2);
    }
}
