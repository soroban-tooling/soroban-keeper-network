//! Event storage and the state derived from it.
//!
//! The `events` table is append-only and authoritative. Every current-state
//! answer -- a task's status, a keeper's balance, the live fee -- is folded
//! from that history on read rather than maintained as separate mutable rows,
//! so derived state can never disagree with the events it came from.

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::str::FromStr;

use crate::events::{EventPayload, EventType, IndexedEvent};
use crate::state::{AdminConfig, KeeperSummary, TaskState};

/// Handle to the event store.
#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

/// A page of events plus the cursor to resume from.
#[derive(Debug, Clone)]
pub struct EventPage {
    pub events: Vec<IndexedEvent>,
    /// Cursor to pass as `after` to fetch the next page, absent at the end.
    pub next_cursor: Option<i64>,
}

/// Where ingestion has reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Checkpoint {
    pub last_ledger: u32,
    pub backfill_complete: bool,
}

impl Store {
    /// Open the store at `database_url` and apply any pending migrations.
    pub async fn connect(database_url: &str) -> Result<Self> {
        let options = SqliteConnectOptions::from_str(database_url)
            .with_context(|| format!("invalid database url: {database_url}"))?
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await
            .context("connecting to the event store")?;

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("applying migrations")?;

        Ok(Self { pool })
    }

    /// Store one event, ignoring it if it has already been ingested.
    ///
    /// Returns the stored event with its assigned cursor, or `None` when the
    /// event was already present. Re-reading a ledger -- an overlapping
    /// backfill page, a retried poll -- is therefore harmless.
    pub async fn insert_event(
        &self,
        ledger: u32,
        ledger_close_time: i64,
        tx_hash: &str,
        event_index: u32,
        payload: &EventPayload,
    ) -> Result<Option<IndexedEvent>> {
        let encoded = serde_json::to_string(payload).context("encoding event payload")?;
        let event_type = payload.event_type();

        let inserted = sqlx::query(
            "INSERT INTO events (
                 ledger, ledger_close_time, tx_hash, event_index,
                 event_type, task_id, owner_address, keeper_address, payload
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tx_hash, event_index) DO NOTHING
             RETURNING cursor",
        )
        .bind(ledger)
        .bind(ledger_close_time)
        .bind(tx_hash)
        .bind(event_index)
        .bind(event_type.as_str())
        .bind(payload.task_id().map(|id| id as i64))
        .bind(payload.owner())
        .bind(payload.keeper())
        .bind(&encoded)
        .fetch_optional(&self.pool)
        .await
        .context("inserting event")?;

        Ok(inserted.map(|row| IndexedEvent {
            cursor: row.get::<i64, _>("cursor"),
            ledger,
            ledger_close_time,
            tx_hash: tx_hash.to_string(),
            event_index,
            event_type,
            payload: payload.clone(),
        }))
    }

    /// Read a page of events after `after`, oldest first.
    ///
    /// Paging on the monotonic cursor rather than an offset means a page
    /// boundary stays correct even when events are ingested mid-traversal.
    pub async fn events_after(
        &self,
        after: Option<i64>,
        limit: u32,
        event_type: Option<EventType>,
        address: Option<&str>,
    ) -> Result<EventPage> {
        // Fetch one extra row to learn whether a further page exists without a
        // second COUNT query.
        let fetch = i64::from(limit) + 1;

        let rows = sqlx::query(
            "SELECT cursor, ledger, ledger_close_time, tx_hash, event_index, payload
             FROM events
             WHERE cursor > ?1
               AND (?2 IS NULL OR event_type = ?2)
               AND (?3 IS NULL OR owner_address = ?3 OR keeper_address = ?3)
             ORDER BY cursor ASC
             LIMIT ?4",
        )
        .bind(after.unwrap_or(0))
        .bind(event_type.map(EventType::as_str))
        .bind(address)
        .bind(fetch)
        .fetch_all(&self.pool)
        .await
        .context("reading event page")?;

        let has_more = rows.len() as i64 > i64::from(limit);
        let mut events = Vec::with_capacity(rows.len().min(limit as usize));
        for row in rows.into_iter().take(limit as usize) {
            events.push(row_to_event(&row)?);
        }
        let next_cursor = if has_more {
            events.last().map(|e| e.cursor)
        } else {
            None
        };

        Ok(EventPage {
            events,
            next_cursor,
        })
    }

    /// Every event for one task, oldest first.
    pub async fn task_history(&self, task_id: u64) -> Result<Vec<IndexedEvent>> {
        let rows = sqlx::query(
            "SELECT cursor, ledger, ledger_close_time, tx_hash, event_index, payload
             FROM events WHERE task_id = ? ORDER BY cursor ASC",
        )
        .bind(task_id as i64)
        .fetch_all(&self.pool)
        .await
        .context("reading task history")?;

        rows.iter().map(row_to_event).collect()
    }

    /// Current state of one task, folded from its full history.
    ///
    /// Returns `None` for a task the indexer has never seen a registration
    /// for. A task's live reward is only correct after folding in every
    /// `RewardIncreased`, which is why this reads the history rather than
    /// trusting the registration row alone.
    pub async fn task_state(&self, task_id: u64) -> Result<Option<TaskState>> {
        let history = self.task_history(task_id).await?;
        Ok(TaskState::fold(task_id, &history))
    }

    /// Task ids registered by an owner, newest first.
    pub async fn task_ids_by_owner(&self, owner: &str) -> Result<Vec<u64>> {
        let rows = sqlx::query(
            "SELECT DISTINCT task_id FROM events
             WHERE owner_address = ? AND task_id IS NOT NULL
             ORDER BY task_id DESC",
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .context("reading tasks by owner")?;

        Ok(rows
            .iter()
            .map(|r| r.get::<i64, _>("task_id") as u64)
            .collect())
    }

    /// Task ids a keeper has claimed or executed, newest first.
    pub async fn task_ids_by_keeper(&self, keeper: &str) -> Result<Vec<u64>> {
        let rows = sqlx::query(
            "SELECT DISTINCT task_id FROM events
             WHERE keeper_address = ? AND task_id IS NOT NULL
             ORDER BY task_id DESC",
        )
        .bind(keeper)
        .fetch_all(&self.pool)
        .await
        .context("reading tasks by keeper")?;

        Ok(rows
            .iter()
            .map(|r| r.get::<i64, _>("task_id") as u64)
            .collect())
    }

    /// Everything the indexer knows about one keeper.
    ///
    /// The credited balance is exposed as its own field rather than left for
    /// each consumer to recompute: executions credit `net_reward`, withdrawals
    /// debit `amount`, and the difference is what the contract's
    /// `keeper_balance` view reports once the indexer is caught up.
    pub async fn keeper_summary(&self, keeper: &str) -> Result<KeeperSummary> {
        let rows = sqlx::query(
            "SELECT cursor, ledger, ledger_close_time, tx_hash, event_index, payload
             FROM events WHERE keeper_address = ? ORDER BY cursor ASC",
        )
        .bind(keeper)
        .fetch_all(&self.pool)
        .await
        .context("reading keeper events")?;

        let events: Vec<IndexedEvent> = rows.iter().map(row_to_event).collect::<Result<_>>()?;
        Ok(KeeperSummary::fold(keeper, &events))
    }

    /// Current admin configuration, folded from the admin event history.
    pub async fn admin_config(&self) -> Result<AdminConfig> {
        let rows = sqlx::query(
            "SELECT cursor, ledger, ledger_close_time, tx_hash, event_index, payload
             FROM events
             WHERE event_type IN (
                 'initialized', 'paused', 'fee_updated', 'admin_transferred',
                 'min_reward_updated', 'fees_swept', 'upgraded'
             )
             ORDER BY cursor ASC",
        )
        .fetch_all(&self.pool)
        .await
        .context("reading admin events")?;

        let events: Vec<IndexedEvent> = rows.iter().map(row_to_event).collect::<Result<_>>()?;
        Ok(AdminConfig::fold(&events))
    }

    /// Read the ingestion checkpoint, absent on a fresh database.
    pub async fn checkpoint(&self) -> Result<Option<Checkpoint>> {
        let row = sqlx::query(
            "SELECT last_ledger, backfill_complete FROM ingest_checkpoint WHERE id = 1",
        )
        .fetch_optional(&self.pool)
        .await
        .context("reading ingest checkpoint")?;

        Ok(row.map(|r| Checkpoint {
            last_ledger: r.get::<i64, _>("last_ledger") as u32,
            backfill_complete: r.get::<i64, _>("backfill_complete") != 0,
        }))
    }

    /// Record ingestion progress.
    pub async fn save_checkpoint(&self, checkpoint: Checkpoint) -> Result<()> {
        sqlx::query(
            "INSERT INTO ingest_checkpoint (id, last_ledger, backfill_complete, updated_at)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET
                 last_ledger = ?1, backfill_complete = ?2, updated_at = ?3",
        )
        .bind(i64::from(checkpoint.last_ledger))
        .bind(i64::from(checkpoint.backfill_complete))
        .bind(chrono::Utc::now().timestamp())
        .execute(&self.pool)
        .await
        .context("saving ingest checkpoint")?;
        Ok(())
    }

    /// The pool, for queries defined in other modules.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

/// Rebuild an [`IndexedEvent`] from a database row.
fn row_to_event(row: &sqlx::sqlite::SqliteRow) -> Result<IndexedEvent> {
    let encoded: String = row.get("payload");
    let payload: EventPayload =
        serde_json::from_str(&encoded).context("decoding stored event payload")?;

    Ok(IndexedEvent {
        cursor: row.get::<i64, _>("cursor"),
        ledger: row.get::<i64, _>("ledger") as u32,
        ledger_close_time: row.get::<i64, _>("ledger_close_time"),
        tx_hash: row.get("tx_hash"),
        event_index: row.get::<i64, _>("event_index") as u32,
        event_type: payload.event_type(),
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::I128;

    async fn store() -> Store {
        Store::connect("sqlite::memory:")
            .await
            .expect("in-memory store")
    }

    fn registered(task_id: u64, owner: &str, reward: i128) -> EventPayload {
        EventPayload::TaskRegistered {
            task_id,
            owner: owner.into(),
            reward: I128(reward),
            deadline: 5_000,
        }
    }

    #[tokio::test]
    async fn migrations_apply_to_a_fresh_database() {
        let store = store().await;
        assert_eq!(store.checkpoint().await.expect("checkpoint read"), None);
    }

    #[tokio::test]
    async fn inserting_assigns_a_monotonic_cursor() {
        let store = store().await;
        let first = store
            .insert_event(10, 100, "tx1", 0, &registered(1, "GOWNER", 500))
            .await
            .expect("insert")
            .expect("new event");
        let second = store
            .insert_event(11, 110, "tx2", 0, &registered(2, "GOWNER", 700))
            .await
            .expect("insert")
            .expect("new event");

        assert!(second.cursor > first.cursor);
    }

    #[tokio::test]
    async fn re_ingesting_the_same_emission_is_a_no_op() {
        let store = store().await;
        let payload = registered(1, "GOWNER", 500);

        assert!(store
            .insert_event(10, 100, "tx1", 0, &payload)
            .await
            .expect("first insert")
            .is_some());
        // Same (tx_hash, event_index): an overlapping backfill page or a
        // retried poll must not duplicate the row.
        assert!(store
            .insert_event(10, 100, "tx1", 0, &payload)
            .await
            .expect("second insert")
            .is_none());

        let page = store
            .events_after(None, 10, None, None)
            .await
            .expect("page");
        assert_eq!(page.events.len(), 1);
    }

    #[tokio::test]
    async fn paging_walks_every_event_exactly_once() {
        let store = store().await;
        for i in 0..5u64 {
            store
                .insert_event(
                    10 + i as u32,
                    100,
                    &format!("tx{i}"),
                    0,
                    &registered(i, "GOWNER", 100),
                )
                .await
                .expect("insert");
        }

        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = store
                .events_after(cursor, 2, None, None)
                .await
                .expect("page");
            seen.extend(page.events.iter().map(|e| e.cursor));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(seen.len(), 5);
        let mut sorted = seen.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 5, "no event returned twice");
    }

    #[tokio::test]
    async fn a_page_boundary_survives_ingestion_mid_traversal() {
        let store = store().await;
        for i in 0..4u64 {
            store
                .insert_event(
                    10 + i as u32,
                    100,
                    &format!("tx{i}"),
                    0,
                    &registered(i, "GOWNER", 100),
                )
                .await
                .expect("insert");
        }

        let first = store.events_after(None, 2, None, None).await.expect("page");
        let resume = first.next_cursor.expect("more pages");

        // A new event arrives between the client's two requests. With an
        // offset this would shift the window and skip a row; with a cursor the
        // second page still continues from where the first ended.
        store
            .insert_event(99, 990, "tx-late", 0, &registered(99, "GOWNER", 100))
            .await
            .expect("insert");

        let second = store
            .events_after(Some(resume), 2, None, None)
            .await
            .expect("page");

        let first_ids: Vec<i64> = first.events.iter().map(|e| e.cursor).collect();
        for event in &second.events {
            assert!(!first_ids.contains(&event.cursor), "no row served twice");
        }
        assert_eq!(second.events.len(), 2);
    }

    #[tokio::test]
    async fn filtering_by_type_and_address_narrows_the_feed() {
        let store = store().await;
        store
            .insert_event(10, 100, "tx1", 0, &registered(1, "GOWNER", 500))
            .await
            .expect("insert");
        store
            .insert_event(
                11,
                110,
                "tx2",
                0,
                &EventPayload::TaskClaimed {
                    task_id: 1,
                    keeper: "GKEEPER".into(),
                    claim_ledger: 11,
                },
            )
            .await
            .expect("insert");

        let claims = store
            .events_after(None, 10, Some(EventType::TaskClaimed), None)
            .await
            .expect("page");
        assert_eq!(claims.events.len(), 1);

        let by_keeper = store
            .events_after(None, 10, None, Some("GKEEPER"))
            .await
            .expect("page");
        assert_eq!(by_keeper.events.len(), 1);

        // The address filter matches either side, so an owner query finds the
        // registration without a separate endpoint.
        let by_owner = store
            .events_after(None, 10, None, Some("GOWNER"))
            .await
            .expect("page");
        assert_eq!(by_owner.events.len(), 1);
    }

    #[tokio::test]
    async fn checkpoint_round_trips() {
        let store = store().await;
        let checkpoint = Checkpoint {
            last_ledger: 4_200,
            backfill_complete: false,
        };
        store.save_checkpoint(checkpoint).await.expect("save");
        assert_eq!(store.checkpoint().await.expect("read"), Some(checkpoint));

        let advanced = Checkpoint {
            last_ledger: 4_500,
            backfill_complete: true,
        };
        store.save_checkpoint(advanced).await.expect("save");
        assert_eq!(store.checkpoint().await.expect("read"), Some(advanced));
    }
}
