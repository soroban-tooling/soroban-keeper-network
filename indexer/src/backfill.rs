//! Catching up from contract genesis, and staying caught up.
//!
//! Backfill and steady-state polling are the same walk: read a ledger range,
//! hand every event to [`Ingestor::ingest_batch`], checkpoint, repeat. They
//! differ only in the range being walked and in whether there is a delay
//! between pages. There is deliberately no backfill-specific parser -- one
//! parsing path means the two cannot drift as the event set evolves.

use anyhow::{Context, Result};
use std::time::Duration;

use crate::ingest::{IngestOutcome, Ingestor};
use crate::rpc::EventSource;
use crate::store::Checkpoint;

/// Drives ingestion over a ledger range.
pub struct Backfiller<S: EventSource> {
    source: S,
    ingestor: Ingestor,
    contract_id: String,
    page_size: u32,
}

/// What a completed backfill did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BackfillReport {
    /// Events stored for the first time.
    pub stored: usize,
    /// Events already present, skipped idempotently.
    pub duplicates: usize,
    /// Events whose topic pair this indexer does not recognise.
    pub unrecognised: usize,
    /// Pages requested from the event source.
    pub pages: usize,
    /// Highest ledger ingested.
    pub last_ledger: u32,
}

impl BackfillReport {
    fn absorb(&mut self, outcome: IngestOutcome) {
        self.stored += outcome.stored;
        self.duplicates += outcome.duplicates;
        self.unrecognised += outcome.unrecognised;
        self.pages += 1;
    }
}

impl<S: EventSource> Backfiller<S> {
    pub fn new(
        source: S,
        ingestor: Ingestor,
        contract_id: impl Into<String>,
        page_size: u32,
    ) -> Self {
        Self {
            source,
            ingestor,
            contract_id: contract_id.into(),
            page_size: page_size.max(1),
        }
    }

    /// The ledger the next walk should start from.
    ///
    /// A stored checkpoint wins over the configured start ledger, which is
    /// what makes an interrupted backfill resume rather than restart. The
    /// resume point is the checkpointed ledger *plus one*: that ledger was
    /// fully ingested before the checkpoint was written.
    pub async fn resume_ledger(&self, configured_start: u32) -> Result<u32> {
        let checkpoint = self.ingestor.store().checkpoint().await?;
        Ok(match checkpoint {
            Some(cp) => cp.last_ledger.saturating_add(1),
            None => configured_start,
        })
    }

    /// Walk from `configured_start` (or the checkpoint) to the chain tip.
    ///
    /// Each page is checkpointed after its events are stored, so an
    /// interruption costs at most the page in flight -- and re-reading that
    /// page on restart is harmless, because ingestion is idempotent.
    pub async fn run_to_tip(&self, configured_start: u32) -> Result<BackfillReport> {
        let mut next = self.resume_ledger(configured_start).await?;
        let tip = self
            .source
            .latest_ledger()
            .await
            .context("reading the chain tip")?;

        let mut report = BackfillReport {
            last_ledger: next.saturating_sub(1),
            ..Default::default()
        };

        while next <= tip {
            let page = self
                .source
                .get_events(&self.contract_id, next, self.page_size)
                .await
                .with_context(|| format!("fetching events from ledger {next}"))?;

            let outcome = self.ingestor.ingest_batch(&page.events).await?;
            report.absorb(outcome);

            // Advance by the page width rather than by the highest ledger that
            // happened to contain an event: a range with no events still has
            // to be marked as scanned, or the walk would never terminate.
            let scanned_through = page
                .latest_ledger_scanned
                .max(next.saturating_add(self.page_size - 1).min(tip));

            report.last_ledger = scanned_through;
            self.ingestor
                .store()
                .save_checkpoint(Checkpoint {
                    last_ledger: scanned_through,
                    backfill_complete: scanned_through >= tip,
                })
                .await?;

            next = scanned_through.saturating_add(1);
        }

        // A tip already behind the resume point means there is nothing to do,
        // but the checkpoint still needs to record that backfill is done so a
        // restart does not treat the database as fresh.
        if report.pages == 0 {
            self.ingestor
                .store()
                .save_checkpoint(Checkpoint {
                    last_ledger: report.last_ledger,
                    backfill_complete: true,
                })
                .await?;
        }

        Ok(report)
    }

    /// Backfill to the tip, then poll for new ledgers indefinitely.
    ///
    /// The steady-state loop is the same walk with a delay between passes; it
    /// re-enters `run_to_tip`, so no second code path exists to drift.
    pub async fn run_forever(&self, configured_start: u32, poll_interval: Duration) -> Result<()> {
        loop {
            let report = self.run_to_tip(configured_start).await?;
            if report.stored > 0 {
                tracing::info!(
                    stored = report.stored,
                    duplicates = report.duplicates,
                    last_ledger = report.last_ledger,
                    "ingested events"
                );
            }
            tokio::time::sleep(poll_interval).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::I128;
    use crate::rpc::fixture::FixtureSource;
    use crate::rpc::{RawEvent, RawValue};
    use crate::state::TaskStatus;
    use crate::store::Store;

    fn event(ledger: u32, tx: &str, topics: [&str; 2], values: Vec<RawValue>) -> RawEvent {
        RawEvent {
            ledger,
            ledger_close_time: i64::from(ledger) * 5,
            tx_hash: tx.to_string(),
            event_index: 0,
            topics: topics.iter().map(|t| (*t).to_string()).collect(),
            values,
        }
    }

    /// A task registered, claimed and executed, plus a partial withdrawal and
    /// a fee change -- enough to check every derived view after a backfill.
    fn history() -> Vec<RawEvent> {
        vec![
            event(
                100,
                "tx-init",
                ["init", "admin"],
                vec![
                    RawValue::Address("GADMIN".into()),
                    RawValue::Address("GTOKEN".into()),
                    RawValue::U32(100),
                ],
            ),
            event(
                101,
                "tx-reg",
                ["reg", "task"],
                vec![
                    RawValue::U64(1),
                    RawValue::Address("GOWNER".into()),
                    RawValue::I128(1_000),
                    RawValue::U64(9_000),
                ],
            ),
            event(
                150,
                "tx-claim",
                ["claim", "task"],
                vec![
                    RawValue::U64(1),
                    RawValue::Address("GKEEPER".into()),
                    RawValue::U32(150),
                ],
            ),
            event(
                200,
                "tx-exec",
                ["exec", "task"],
                vec![
                    RawValue::U64(1),
                    RawValue::Address("GKEEPER".into()),
                    RawValue::I128(990),
                    RawValue::Bytes("proof".into()),
                ],
            ),
            event(
                250,
                "tx-wdraw",
                ["wdraw", "reward"],
                vec![RawValue::Address("GKEEPER".into()), RawValue::I128(400)],
            ),
            event(
                300,
                "tx-fee",
                ["fee", "admin"],
                vec![RawValue::U32(100), RawValue::U32(250)],
            ),
        ]
    }

    async fn backfiller(source: FixtureSource, page_size: u32) -> Backfiller<FixtureSource> {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        Backfiller::new(source, Ingestor::new(store), "CCONTRACT", page_size)
    }

    #[tokio::test]
    async fn a_fresh_database_backfills_from_the_configured_start_ledger() {
        let backfiller = backfiller(FixtureSource::new(history(), 320), 100).await;
        let report = backfiller.run_to_tip(100).await.expect("backfill");

        assert_eq!(report.stored, 6);
        assert_eq!(report.duplicates, 0);
        assert!(report.last_ledger >= 320);
    }

    #[tokio::test]
    async fn events_before_the_start_ledger_are_not_ingested() {
        // Starting at 200 skips the registration and claim: the walk begins
        // where it is told to, not at the earliest event available.
        let backfiller = backfiller(FixtureSource::new(history(), 320), 100).await;
        backfiller.run_to_tip(200).await.expect("backfill");

        let state = backfiller
            .ingestor
            .store()
            .task_state(1)
            .await
            .expect("query");
        // No TaskRegistered was ingested, so no task state is fabricated.
        assert_eq!(state, None);
    }

    #[tokio::test]
    async fn derived_views_match_the_contract_after_a_full_backfill() {
        let backfiller = backfiller(FixtureSource::new(history(), 320), 50).await;
        backfiller.run_to_tip(100).await.expect("backfill");
        let store = backfiller.ingestor.store();

        // get_task: executed, with the escrowed reward and the net payout.
        let task = store.task_state(1).await.expect("query").expect("task");
        assert_eq!(task.status, TaskStatus::Executed);
        assert_eq!(task.reward, I128(1_000));
        assert_eq!(task.net_reward, Some(I128(990)));
        assert_eq!(task.keeper.as_deref(), Some("GKEEPER"));

        // keeper_balance: 990 earned less 400 withdrawn.
        let keeper = store.keeper_summary("GKEEPER").await.expect("query");
        assert_eq!(keeper.credited_balance, I128(590));

        // get_fee_bps: the latest FeeUpdated wins over Initialized.
        let config = store.admin_config().await.expect("query");
        assert_eq!(config.fee_bps, Some(250));
        assert_eq!(config.admin.as_deref(), Some("GADMIN"));
    }

    #[tokio::test]
    async fn an_interrupted_backfill_resumes_from_its_checkpoint() {
        let source = FixtureSource::new(history(), 320);
        let backfiller = backfiller(source.clone(), 50).await;

        // Fail part-way through, after some pages have been checkpointed.
        source.fail_once_at(210);
        let err = backfiller.run_to_tip(100).await.expect_err("interrupted");
        assert!(err.to_string().contains("fetching events from ledger"));

        let checkpoint = backfiller
            .ingestor
            .store()
            .checkpoint()
            .await
            .expect("query")
            .expect("progress was checkpointed before the failure");
        // Pages of 50 from ledger 100: the page covering 200-249 is the one
        // that failed, so everything through 199 is saved and 200 onward is
        // not -- the checkpoint records completed pages only.
        assert_eq!(checkpoint.last_ledger, 199, "earlier pages were saved");
        assert!(!checkpoint.backfill_complete);

        // Resuming picks up after the checkpoint rather than at ledger 100.
        let resume = backfiller.resume_ledger(100).await.expect("resume point");
        assert_eq!(resume, checkpoint.last_ledger + 1);

        let report = backfiller.run_to_tip(100).await.expect("resumed backfill");
        assert_eq!(report.duplicates, 0, "already-stored pages are not re-read");

        // The end state is the same as an uninterrupted run.
        let task = backfiller
            .ingestor
            .store()
            .task_state(1)
            .await
            .expect("query")
            .expect("task");
        assert_eq!(task.status, TaskStatus::Executed);
        let config = backfiller
            .ingestor
            .store()
            .admin_config()
            .await
            .expect("query");
        assert_eq!(config.fee_bps, Some(250));
    }

    #[tokio::test]
    async fn re_running_a_completed_backfill_stores_nothing_new() {
        let backfiller = backfiller(FixtureSource::new(history(), 320), 100).await;
        let first = backfiller.run_to_tip(100).await.expect("backfill");
        assert_eq!(first.stored, 6);

        // Restarting the service must not duplicate history. Nothing is
        // re-read at all, because the checkpoint has moved past the tip.
        let second = backfiller.run_to_tip(100).await.expect("second run");
        assert_eq!(second.stored, 0);
        assert_eq!(second.duplicates, 0);

        let page = backfiller
            .ingestor
            .store()
            .events_after(None, 100, None, None)
            .await
            .expect("feed");
        assert_eq!(page.events.len(), 6);
    }

    #[tokio::test]
    async fn a_ledger_range_with_no_events_still_advances() {
        // Events cluster at the start; the walk must still reach the tip
        // rather than stalling on an empty page.
        let sparse = vec![event(
            100,
            "tx-only",
            ["exp", "task"],
            vec![RawValue::U64(1)],
        )];
        let backfiller = backfiller(FixtureSource::new(sparse, 1_000), 100).await;

        let report = backfiller.run_to_tip(100).await.expect("backfill");
        assert_eq!(report.stored, 1);
        assert!(report.last_ledger >= 1_000, "reached the tip");
        assert!(report.pages >= 9, "walked the empty ranges too");
    }

    #[tokio::test]
    async fn backfill_completion_is_recorded_for_the_next_start() {
        let backfiller = backfiller(FixtureSource::new(history(), 320), 100).await;
        backfiller.run_to_tip(100).await.expect("backfill");

        let checkpoint = backfiller
            .ingestor
            .store()
            .checkpoint()
            .await
            .expect("query")
            .expect("checkpoint");
        assert!(checkpoint.backfill_complete);
    }

    #[tokio::test]
    async fn steady_state_ingestion_uses_the_same_path_as_backfill() {
        let mut events = history();
        let source = FixtureSource::new(events.clone(), 320);
        let backfiller = backfiller(source, 100).await;
        backfiller.run_to_tip(100).await.expect("backfill");

        // A new event arrives after the initial catch-up. Re-entering the same
        // walk ingests it -- there is no separate steady-state parser.
        events.push(event(
            330,
            "tx-late",
            ["reg", "task"],
            vec![
                RawValue::U64(2),
                RawValue::Address("GOWNER".into()),
                RawValue::I128(77),
                RawValue::U64(9_999),
            ],
        ));
        let extended = FixtureSource::new(events, 340);
        let resumed = Backfiller::new(extended, backfiller.ingestor.clone(), "CCONTRACT", 100);

        let report = resumed.run_to_tip(100).await.expect("steady state pass");
        assert_eq!(report.stored, 1, "only the new event");

        let task = resumed
            .ingestor
            .store()
            .task_state(2)
            .await
            .expect("query")
            .expect("new task");
        assert_eq!(task.reward, I128(77));
    }
}
