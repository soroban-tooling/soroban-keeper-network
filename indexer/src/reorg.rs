//! Detecting a ledger that the RPC source later reports differently.
//!
//! # The policy, and why it is this one
//!
//! Issue 0224 implements "whatever reorg-handling policy issue 0218 decided".
//! Issue 0218's deliverable — `docs/INDEXER_DESIGN.md` — was never produced, so
//! the decision is recorded here, in the terms 0218 asked for: *state plainly
//! whether this is a real risk on Stellar's consensus model or a defensive
//! measure against RPC-node bugs, since the two motivate different handling.*
//!
//! **It is the second.** Stellar reaches agreement through SCP, which is a
//! federated Byzantine agreement protocol with *deterministic* finality: a
//! ledger that has closed is closed, and there is no longest-chain rule under
//! which a competing history can later replace it. Stellar has no
//! probabilistic-finality reorganization for an indexer to defend against.
//!
//! What *does* happen is that an RPC node briefly reports an inconsistent view
//! — mid-catchup, serving from a partially-applied buffer, or simply buggy.
//! That looks superficially like a reorg and is not one, and the difference
//! decides the handling:
//!
//! - A genuine reorg would mean the chain changed its mind, and the right
//!   response is to roll back and re-ingest, because the new answer is
//!   authoritative.
//! - An inconsistent node view means *one of the two answers is wrong and we
//!   cannot tell which*. Auto-reconciling would overwrite correct data with a
//!   bad node's output, silently, and the audit trail would record the
//!   overwrite as if it were the truth.
//!
//! So this module **detects and alerts. It does not auto-reconcile.** That is
//! the option issue 0224's acceptance criteria anticipated and asked to be
//! implemented exactly rather than approximated:
//!
//! > if that policy was "this is not a real risk on Stellar, treat any
//! > discrepancy as an RPC-node bug and alert rather than auto-reconcile,"
//! > implement exactly that rather than building silent reconciliation issue
//! > 0218 explicitly ruled out.
//!
//! # What that buys
//!
//! The database is never left holding a mix of old and new data for one ledger,
//! because nothing is ever partially rewritten. On a discrepancy, ingestion
//! stops at the last consistent ledger and the disagreement is recorded in full
//! — both fingerprints, so an operator can go and ask the node about a specific
//! ledger rather than about a feeling.
//!
//! Fail-closed is the right default for an append-only audit log: a halted
//! indexer is visibly behind, while a silently reconciled one looks healthy and
//! is wrong.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::rpc::RawEvent;

/// A ledger's observed event content, reduced to something comparable.
///
/// Stored per ledger at ingest time, and recomputed whenever that ledger is
/// seen again — an overlapping backfill page, a retried poll, a restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerFingerprint {
    pub ledger: u32,
    /// How many events the source reported for this ledger.
    pub event_count: u32,
    /// Digest over the ledger's events; see [`fingerprint`].
    pub digest: u64,
}

/// Compute a ledger's fingerprint from the events a source reported for it.
///
/// Order-independent: events are folded in a canonical order — `(tx_hash,
/// event_index)`, which is the same pair the store's uniqueness constraint uses
/// — so a source that returns the same events in a different order is
/// *consistent*, not discrepant. Reporting a paging artifact as a chain-level
/// disagreement would train operators to ignore the alert.
///
/// The digest is FNV-1a/64 rather than a cryptographic hash, deliberately.
/// The threat model here is a confused or buggy node, not an adversary
/// constructing a collision: nothing downstream trusts the digest as proof of
/// anything, it only has to notice that two views differ. A cryptographic hash
/// would mean a new dependency to defend against an attacker who, if they
/// existed, would simply return consistent-but-false events instead.
pub fn fingerprint(ledger: u32, events: &[RawEvent]) -> LedgerFingerprint {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn fold(acc: u64, bytes: &[u8]) -> u64 {
        bytes.iter().fold(acc, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
        })
    }

    let mut in_ledger: Vec<&RawEvent> = events
        .iter()
        .filter(|event| event.ledger == ledger)
        .collect();
    in_ledger.sort_by(|a, b| (&a.tx_hash, a.event_index).cmp(&(&b.tx_hash, b.event_index)));

    let mut digest = OFFSET;
    for event in &in_ledger {
        digest = fold(digest, event.tx_hash.as_bytes());
        digest = fold(digest, &event.event_index.to_be_bytes());
        digest = fold(digest, &event.ledger_close_time.to_be_bytes());
        for topic in &event.topics {
            digest = fold(digest, topic.as_bytes());
        }
        // Payload values are folded through their serialized form rather than
        // field by field: a value's *shape* changing is exactly the kind of
        // disagreement worth catching, and enumerating variants here would
        // silently stop covering any variant added later.
        if let Ok(encoded) = serde_json::to_vec(&event.values) {
            digest = fold(digest, &encoded);
        }
    }

    LedgerFingerprint {
        ledger,
        event_count: in_ledger.len() as u32,
        digest,
    }
}

/// How a re-observed ledger compares to what was recorded for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    /// This ledger had not been fingerprinted before; the fingerprint is now recorded.
    FirstSight(LedgerFingerprint),
    /// The source reported the same content as last time.
    Consistent(LedgerFingerprint),
    /// The source reported different content. Nothing was overwritten.
    Discrepant(Discrepancy),
}

/// A ledger the source has reported two different ways.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Discrepancy {
    pub ledger: u32,
    /// What was recorded when this ledger was first ingested.
    pub recorded: LedgerFingerprint,
    /// What the source is reporting now.
    pub observed: LedgerFingerprint,
    pub kind: DiscrepancyKind,
}

/// Which way the two views differ — the first thing an operator needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiscrepancyKind {
    /// The source now reports fewer events than it did. The most alarming
    /// shape: it suggests a node serving from an incomplete view.
    EventsDisappeared,
    /// The source now reports more events than it did. Often a node that was
    /// mid-catchup on the first read and has since caught up.
    EventsAppeared,
    /// The same number of events, with different content.
    ContentChanged,
}

impl Discrepancy {
    /// A one-line summary for an alert or a log line.
    pub fn summary(&self) -> String {
        let detail = match self.kind {
            DiscrepancyKind::EventsDisappeared => format!(
                "{} events previously, {} now",
                self.recorded.event_count, self.observed.event_count
            ),
            DiscrepancyKind::EventsAppeared => format!(
                "{} events previously, {} now",
                self.recorded.event_count, self.observed.event_count
            ),
            DiscrepancyKind::ContentChanged => format!(
                "{} events both times, digest {:#x} then {:#x}",
                self.recorded.event_count, self.recorded.digest, self.observed.digest
            ),
        };
        format!(
            "ledger {} reported inconsistently by the event source ({detail}). \
             Stellar has deterministic finality, so this is an RPC-node view \
             problem rather than a chain reorganization. Ingestion has stopped \
             at the last consistent ledger; no stored event was modified.",
            self.ledger
        )
    }
}

/// Where a detected discrepancy is reported.
///
/// A trait rather than a direct call to `tracing`, because "the indexer stopped
/// because the node disagreed with itself" needs to reach a human, and which
/// channel that is belongs to the deployment. The logging implementation is the
/// floor, not the intended ceiling.
pub trait DiscrepancyAlert {
    fn raise(&self, discrepancy: &Discrepancy);
}

/// Logs at `error` level. Always in the chain, so a deployment that wires
/// nothing else still leaves a trace.
#[derive(Debug, Clone, Copy, Default)]
pub struct LoggingAlert;

impl DiscrepancyAlert for LoggingAlert {
    fn raise(&self, discrepancy: &Discrepancy) {
        tracing::error!(
            ledger = discrepancy.ledger,
            recorded_events = discrepancy.recorded.event_count,
            observed_events = discrepancy.observed.event_count,
            recorded_digest = format!("{:#x}", discrepancy.recorded.digest),
            observed_digest = format!("{:#x}", discrepancy.observed.digest),
            kind = ?discrepancy.kind,
            "{}",
            discrepancy.summary()
        );
    }
}

/// Records ledger fingerprints and compares re-observations against them.
///
/// Deliberately has no method that rewrites a ledger. Reconciliation is not an
/// operation this type offers, because offering it is how "alert, don't
/// reconcile" quietly becomes "reconcile" the first time someone is under
/// pressure to clear an alert.
pub struct ReorgDetector<A: DiscrepancyAlert = LoggingAlert> {
    pool: SqlitePool,
    alert: A,
}

impl ReorgDetector<LoggingAlert> {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            alert: LoggingAlert,
        }
    }
}

impl<A: DiscrepancyAlert> ReorgDetector<A> {
    pub fn with_alert(pool: SqlitePool, alert: A) -> Self {
        Self { pool, alert }
    }

    /// Compare `events` for `ledger` against what was recorded, recording the
    /// fingerprint on first sight.
    ///
    /// On a discrepancy the stored fingerprint is left **unchanged** and the
    /// alert is raised. Overwriting it would erase the evidence that the two
    /// views ever differed, which is the only thing that makes the incident
    /// investigable afterwards.
    pub async fn observe(&self, ledger: u32, events: &[RawEvent]) -> Result<Observation> {
        let observed = fingerprint(ledger, events);

        let existing =
            sqlx::query("SELECT event_count, digest FROM ledger_fingerprints WHERE ledger = ?")
                .bind(ledger)
                .fetch_optional(&self.pool)
                .await
                .context("reading the recorded ledger fingerprint")?;

        let Some(row) = existing else {
            sqlx::query(
                "INSERT INTO ledger_fingerprints (ledger, event_count, digest, first_seen_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (ledger) DO NOTHING",
            )
            .bind(ledger)
            .bind(observed.event_count)
            .bind(observed.digest as i64)
            .bind(chrono::Utc::now().timestamp())
            .execute(&self.pool)
            .await
            .context("recording the ledger fingerprint")?;

            return Ok(Observation::FirstSight(observed));
        };

        let recorded = LedgerFingerprint {
            ledger,
            event_count: row.get::<i64, _>("event_count") as u32,
            digest: row.get::<i64, _>("digest") as u64,
        };

        if recorded == observed {
            return Ok(Observation::Consistent(observed));
        }

        let kind = match observed.event_count.cmp(&recorded.event_count) {
            std::cmp::Ordering::Less => DiscrepancyKind::EventsDisappeared,
            std::cmp::Ordering::Greater => DiscrepancyKind::EventsAppeared,
            std::cmp::Ordering::Equal => DiscrepancyKind::ContentChanged,
        };

        let discrepancy = Discrepancy {
            ledger,
            recorded,
            observed,
            kind,
        };
        self.alert.raise(&discrepancy);
        Ok(Observation::Discrepant(discrepancy))
    }

    /// The fingerprint recorded for `ledger`, if any.
    pub async fn recorded(&self, ledger: u32) -> Result<Option<LedgerFingerprint>> {
        let row =
            sqlx::query("SELECT event_count, digest FROM ledger_fingerprints WHERE ledger = ?")
                .bind(ledger)
                .fetch_optional(&self.pool)
                .await
                .context("reading the recorded ledger fingerprint")?;

        Ok(row.map(|row| LedgerFingerprint {
            ledger,
            event_count: row.get::<i64, _>("event_count") as u32,
            digest: row.get::<i64, _>("digest") as u64,
        }))
    }
}

/// Raised when ingestion stops because the source contradicted itself.
///
/// A distinct error type so a caller can tell "the node disagreed with itself"
/// apart from an ordinary fetch failure. They need different operator
/// responses: one is retried, the other is investigated.
#[derive(Debug, thiserror::Error)]
#[error("{}", .0.summary())]
pub struct LedgerDiscrepancyError(pub Discrepancy);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{RawEvent, RawValue};
    use crate::store::Store;

    fn event(ledger: u32, tx: &str, index: u32, value: &str) -> RawEvent {
        RawEvent {
            ledger,
            ledger_close_time: 1_700_000_000 + i64::from(ledger),
            tx_hash: tx.to_string(),
            event_index: index,
            topics: vec!["task".into(), "claimed".into()],
            values: vec![RawValue::Address(value.to_string())],
        }
    }

    async fn detector() -> ReorgDetector<LoggingAlert> {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        ReorgDetector::new(store.pool().clone())
    }

    #[test]
    fn fingerprint_ignores_source_ordering() {
        // A source returning the same events in a different order is a paging
        // artifact, not a disagreement. Reporting it as one would train
        // operators to ignore the alert.
        let a = event(10, "tx-a", 0, "GA");
        let b = event(10, "tx-b", 1, "GB");

        assert_eq!(
            fingerprint(10, &[a.clone(), b.clone()]),
            fingerprint(10, &[b, a])
        );
    }

    #[test]
    fn fingerprint_only_covers_the_named_ledger() {
        let this = event(10, "tx-a", 0, "GA");
        let other = event(11, "tx-b", 0, "GB");

        assert_eq!(
            fingerprint(10, &[this.clone()]),
            fingerprint(10, &[this, other])
        );
    }

    #[test]
    fn fingerprint_changes_with_payload_content() {
        assert_ne!(
            fingerprint(10, &[event(10, "tx-a", 0, "GA")]),
            fingerprint(10, &[event(10, "tx-a", 0, "GB")])
        );
    }

    #[test]
    fn fingerprint_of_an_empty_ledger_is_stable() {
        assert_eq!(fingerprint(10, &[]), fingerprint(10, &[]));
        assert_eq!(fingerprint(10, &[]).event_count, 0);
    }

    #[tokio::test]
    async fn first_sight_records_the_fingerprint() {
        let detector = detector().await;
        let events = vec![event(10, "tx-a", 0, "GA")];

        let observation = detector.observe(10, &events).await.expect("observe");

        assert!(matches!(observation, Observation::FirstSight(_)));
        assert_eq!(
            detector.recorded(10).await.expect("recorded"),
            Some(fingerprint(10, &events))
        );
    }

    #[tokio::test]
    async fn re_reading_the_same_ledger_is_consistent() {
        // The ordinary case: overlapping backfill pages and retried polls.
        let detector = detector().await;
        let events = vec![event(10, "tx-a", 0, "GA")];

        detector.observe(10, &events).await.expect("first");
        let second = detector.observe(10, &events).await.expect("second");

        assert!(matches!(second, Observation::Consistent(_)));
    }

    #[tokio::test]
    async fn a_source_that_changes_its_answer_is_detected() {
        // The acceptance criterion's test: a mock source that changes its
        // answer between two polls, with no real reorg needed.
        let detector = detector().await;

        detector
            .observe(10, &[event(10, "tx-a", 0, "GA")])
            .await
            .expect("first");
        let second = detector
            .observe(10, &[event(10, "tx-a", 0, "GB")])
            .await
            .expect("second");

        let Observation::Discrepant(discrepancy) = second else {
            panic!("expected a discrepancy, got {second:?}");
        };
        assert_eq!(discrepancy.ledger, 10);
        assert_eq!(discrepancy.kind, DiscrepancyKind::ContentChanged);
    }

    #[tokio::test]
    async fn a_vanished_event_is_distinguished_from_a_new_one() {
        // The two shapes need different operator responses, so they are named
        // differently rather than both being "mismatch".
        let shrinking = detector().await;
        shrinking
            .observe(
                10,
                &[event(10, "tx-a", 0, "GA"), event(10, "tx-b", 1, "GB")],
            )
            .await
            .expect("first");
        let observation = shrinking
            .observe(10, &[event(10, "tx-a", 0, "GA")])
            .await
            .expect("second");
        assert!(matches!(
            observation,
            Observation::Discrepant(Discrepancy {
                kind: DiscrepancyKind::EventsDisappeared,
                ..
            })
        ));

        let growing = detector().await;
        growing
            .observe(10, &[event(10, "tx-a", 0, "GA")])
            .await
            .expect("first");
        let observation = growing
            .observe(
                10,
                &[event(10, "tx-a", 0, "GA"), event(10, "tx-b", 1, "GB")],
            )
            .await
            .expect("second");
        assert!(matches!(
            observation,
            Observation::Discrepant(Discrepancy {
                kind: DiscrepancyKind::EventsAppeared,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_discrepancy_does_not_overwrite_the_recorded_fingerprint() {
        // The policy in one test. Overwriting would erase the evidence that the
        // two views ever differed, which is the only thing that makes the
        // incident investigable afterwards.
        let detector = detector().await;
        let original = vec![event(10, "tx-a", 0, "GA")];

        detector.observe(10, &original).await.expect("first");
        detector
            .observe(10, &[event(10, "tx-a", 0, "GB")])
            .await
            .expect("second");

        assert_eq!(
            detector.recorded(10).await.expect("recorded"),
            Some(fingerprint(10, &original)),
            "the first view must survive the disagreement"
        );
    }

    #[tokio::test]
    async fn the_alert_carries_both_views() {
        use std::sync::{Arc, Mutex};

        #[derive(Clone, Default)]
        struct Recording(Arc<Mutex<Vec<Discrepancy>>>);
        impl DiscrepancyAlert for Recording {
            fn raise(&self, discrepancy: &Discrepancy) {
                self.0.lock().expect("lock").push(discrepancy.clone());
            }
        }

        let store = Store::connect("sqlite::memory:").await.expect("store");
        let alert = Recording::default();
        let detector = ReorgDetector::with_alert(store.pool().clone(), alert.clone());

        detector
            .observe(10, &[event(10, "tx-a", 0, "GA")])
            .await
            .expect("first");
        detector
            .observe(10, &[event(10, "tx-a", 0, "GB")])
            .await
            .expect("second");

        let raised = alert.0.lock().expect("lock");
        assert_eq!(
            raised.len(),
            1,
            "one alert per disagreement, not one per event"
        );
        assert_ne!(raised[0].recorded.digest, raised[0].observed.digest);
        assert!(raised[0].summary().contains("deterministic finality"));
        assert!(raised[0].summary().contains("no stored event was modified"));
    }

    #[tokio::test]
    async fn ledgers_are_tracked_independently() {
        let detector = detector().await;

        detector
            .observe(10, &[event(10, "tx-a", 0, "GA")])
            .await
            .expect("l10");
        detector
            .observe(11, &[event(11, "tx-b", 0, "GB")])
            .await
            .expect("l11");

        // A disagreement about ledger 10 says nothing about ledger 11.
        let observation = detector
            .observe(10, &[event(10, "tx-a", 0, "GZ")])
            .await
            .expect("l10 again");
        assert!(matches!(observation, Observation::Discrepant(_)));

        let observation = detector
            .observe(11, &[event(11, "tx-b", 0, "GB")])
            .await
            .expect("l11 again");
        assert!(matches!(observation, Observation::Consistent(_)));
    }
}
