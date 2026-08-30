//! The ingestion apply path — where idempotency lives (issue 0230).
//!
//! RPC sources can redeliver an event the indexer already processed: a
//! retried poll after a timeout whose response actually landed, an
//! at-least-once streaming guarantee, an operator re-running a ledger range
//! (which docs/INDEXER_DESIGN.md §3 blesses as the recovery action). The
//! contract here is that applying the same event twice leaves the database
//! exactly as applying it once — for the raw `events` row AND every derived
//! effect.
//!
//! ## The uniqueness key
//!
//! `event_id` — the RPC's TOID-derived event id: (ledger, transaction
//! application order, operation index, event index), rendered by the RPC as
//! e.g. `0000019519413221376-0000000001`. It is deterministic per protocol,
//! so it is **stable across the backfill and steady-state ingestion paths**
//! (0223 / 0219): both are the same loop reading the same `getEvents`
//! surface, so a ledger ingested during backfill and re-served later in
//! steady state carries byte-identical ids. The key is enforced by the
//! `events` primary key, not by application memory, so it holds across
//! restarts and across concurrent writers.
//!
//! ## The gate
//!
//! `apply` runs one transaction per event: insert the raw row with
//! `on conflict do nothing`, and apply derived effects ONLY if that insert
//! actually inserted. A duplicate therefore short-circuits before any
//! derived table is touched — the derived views are protected by the same
//! single gate rather than each needing its own dedup logic.

use serde_json::json;
use sqlx::PgPool;

/// A decoded registry event, one variant per event in `events.rs` (the
/// fifteen names and payload fields from docs/INDEXER_DESIGN.md §6). The
/// XDR-decode step that produces these from raw `getEvents` output is the
/// per-event ingestion work of 0220–0222; this module owns what happens
/// once a decoded event exists.
#[derive(Debug, Clone)]
pub enum Event {
    TaskRegistered {
        task_id: u64,
        owner: String,
        reward: i128,
        deadline: u64,
    },
    TaskClaimed {
        task_id: u64,
        keeper: String,
        ledger: u32,
    },
    TaskExecuted {
        task_id: u64,
        keeper: String,
        net_reward: i128,
        proof: Vec<u8>,
    },
    TaskExpired {
        task_id: u64,
    },
    TaskCancelled {
        task_id: u64,
        owner: String,
    },
    RewardsWithdrawn {
        keeper: String,
        amount: i128,
    },
    Paused {
        paused: bool,
    },
    FeeUpdated {
        old_bps: u32,
        new_bps: u32,
    },
    AdminTransferred {
        old_admin: String,
        new_admin: String,
    },
    RewardIncreased {
        task_id: u64,
        new_reward: i128,
    },
    DeadlineExtended {
        task_id: u64,
        new_deadline: u64,
    },
    MinRewardUpdated {
        old_min: i128,
        new_min: i128,
    },
    FeesSwept {
        treasury: String,
        amount: i128,
        remaining: i128,
    },
    Initialized {
        admin: String,
        reward_token: String,
        fee_bps: u32,
    },
    Upgraded {
        admin: String,
        new_wasm_hash: [u8; 32],
    },
}

impl Event {
    /// The `events.type` value — the design's fifteen names.
    pub fn type_name(&self) -> &'static str {
        match self {
            Event::TaskRegistered { .. } => "task_registered",
            Event::TaskClaimed { .. } => "task_claimed",
            Event::TaskExecuted { .. } => "task_executed",
            Event::TaskExpired { .. } => "task_expired",
            Event::TaskCancelled { .. } => "task_cancelled",
            Event::RewardsWithdrawn { .. } => "rewards_withdrawn",
            Event::Paused { .. } => "paused",
            Event::FeeUpdated { .. } => "fee_updated",
            Event::AdminTransferred { .. } => "admin_transferred",
            Event::RewardIncreased { .. } => "reward_increased",
            Event::DeadlineExtended { .. } => "deadline_extended",
            Event::MinRewardUpdated { .. } => "min_reward_updated",
            Event::FeesSwept { .. } => "fees_swept",
            Event::Initialized { .. } => "initialized",
            Event::Upgraded { .. } => "upgraded",
        }
    }

    fn payload(&self) -> serde_json::Value {
        match self {
            Event::TaskRegistered {
                task_id,
                owner,
                reward,
                deadline,
            } => json!({
                "task_id": task_id, "owner": owner,
                "reward": reward.to_string(), "deadline": deadline,
            }),
            Event::TaskClaimed {
                task_id,
                keeper,
                ledger,
            } => {
                json!({ "task_id": task_id, "keeper": keeper, "ledger": ledger })
            }
            Event::TaskExecuted {
                task_id,
                keeper,
                net_reward,
                proof,
            } => json!({
                "task_id": task_id, "keeper": keeper,
                "net_reward": net_reward.to_string(),
                "proof": hex(proof),
            }),
            Event::TaskExpired { task_id } => json!({ "task_id": task_id }),
            Event::TaskCancelled { task_id, owner } => {
                json!({ "task_id": task_id, "owner": owner })
            }
            Event::RewardsWithdrawn { keeper, amount } => {
                json!({ "keeper": keeper, "amount": amount.to_string() })
            }
            Event::Paused { paused } => json!({ "paused": paused }),
            Event::FeeUpdated { old_bps, new_bps } => {
                json!({ "old_bps": old_bps, "new_bps": new_bps })
            }
            Event::AdminTransferred {
                old_admin,
                new_admin,
            } => {
                json!({ "old_admin": old_admin, "new_admin": new_admin })
            }
            Event::RewardIncreased {
                task_id,
                new_reward,
            } => {
                json!({ "task_id": task_id, "new_reward": new_reward.to_string() })
            }
            Event::DeadlineExtended {
                task_id,
                new_deadline,
            } => {
                json!({ "task_id": task_id, "new_deadline": new_deadline })
            }
            Event::MinRewardUpdated { old_min, new_min } => {
                json!({ "old_min": old_min.to_string(), "new_min": new_min.to_string() })
            }
            Event::FeesSwept {
                treasury,
                amount,
                remaining,
            } => json!({
                "treasury": treasury,
                "amount": amount.to_string(), "remaining": remaining.to_string(),
            }),
            Event::Initialized {
                admin,
                reward_token,
                fee_bps,
            } => json!({
                "admin": admin, "reward_token": reward_token, "fee_bps": fee_bps,
            }),
            Event::Upgraded {
                admin,
                new_wasm_hash,
            } => {
                json!({ "admin": admin, "new_wasm_hash": hex(new_wasm_hash) })
            }
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What `apply` did with the event.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// First delivery: raw row inserted, derived effects applied.
    Inserted,
    /// The uniqueness key matched an existing row: nothing changed anywhere.
    Duplicate,
}

/// Apply one decoded event: raw insert gated by the uniqueness key, derived
/// effects only when the insert actually inserted, all in one transaction —
/// so a crash between the two leaves nothing half-applied and a redelivery
/// after the crash replays cleanly.
pub async fn apply(
    pool: &PgPool,
    event_id: &str,
    ledger: u32,
    closed_at: &str,
    contract_id: &str,
    event: &Event,
) -> Result<Applied, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let inserted = sqlx::query(
        "insert into events (event_id, ledger, closed_at, contract_id, type, payload)
         values ($1, $2, $3::timestamptz, $4, $5, $6)
         on conflict (event_id) do nothing",
    )
    .bind(event_id)
    .bind(ledger as i64)
    .bind(closed_at)
    .bind(contract_id)
    .bind(event.type_name())
    .bind(event.payload())
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if inserted == 0 {
        // Redelivery. The raw row already exists, which means every derived
        // effect for this event has already been applied exactly once —
        // touch nothing.
        tx.rollback().await?;
        return Ok(Applied::Duplicate);
    }

    apply_derived(&mut tx, ledger, event).await?;
    tx.commit().await?;
    Ok(Applied::Inserted)
}

/// Derived-view effects. Wired here for the events the idempotency proof
/// exercises end to end; 0220–0222 extend this match with the remaining
/// projections against the same gate — a new arm inherits idempotency for
/// free, because this function is only ever reached on first delivery.
async fn apply_derived(
    tx: &mut sqlx::PgConnection,
    ledger: u32,
    event: &Event,
) -> Result<(), sqlx::Error> {
    match event {
        Event::TaskRegistered {
            task_id,
            owner,
            reward,
            deadline,
        } => {
            sqlx::query(
                "insert into tasks
                     (task_id, owner, reward, deadline, status, created_ledger, updated_ledger)
                 values ($1, $2, $3::numeric, $4, 'registered', $5, $5)
                 on conflict (task_id) do nothing",
            )
            .bind(*task_id as i64)
            .bind(owner)
            .bind(reward.to_string())
            .bind(*deadline as i64)
            .bind(ledger as i64)
            .execute(&mut *tx)
            .await?;
        }
        Event::TaskClaimed {
            task_id,
            keeper,
            ledger: claim_ledger,
        } => {
            sqlx::query(
                "update tasks set status = 'claimed', claimed_by = $2,
                     claimed_at_ledger = $3, updated_ledger = $4
                 where task_id = $1",
            )
            .bind(*task_id as i64)
            .bind(keeper)
            .bind(*claim_ledger as i64)
            .bind(ledger as i64)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "insert into keepers (keeper, tasks_claimed) values ($1, 1)
                 on conflict (keeper) do update
                     set tasks_claimed = keepers.tasks_claimed + 1",
            )
            .bind(keeper)
            .execute(&mut *tx)
            .await?;
        }
        Event::TaskExecuted {
            task_id,
            keeper,
            net_reward,
            proof,
        } => {
            sqlx::query(
                "update tasks set status = 'executed', executed_by = $2,
                     net_reward = $3::numeric, proof = $4, updated_ledger = $5
                 where task_id = $1",
            )
            .bind(*task_id as i64)
            .bind(keeper)
            .bind(net_reward.to_string())
            .bind(proof.as_slice())
            .bind(ledger as i64)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "insert into keepers (keeper, balance, lifetime_earned, tasks_executed)
                 values ($1, $2::numeric, $2::numeric, 1)
                 on conflict (keeper) do update set
                     balance = keepers.balance + excluded.balance,
                     lifetime_earned = keepers.lifetime_earned + excluded.lifetime_earned,
                     tasks_executed = keepers.tasks_executed + 1",
            )
            .bind(keeper)
            .bind(net_reward.to_string())
            .execute(&mut *tx)
            .await?;
        }
        Event::RewardsWithdrawn { keeper, amount } => {
            sqlx::query("update keepers set balance = balance - $2::numeric where keeper = $1")
                .bind(keeper)
                .bind(amount.to_string())
                .execute(&mut *tx)
                .await?;
        }
        Event::TaskExpired { task_id } => {
            set_task_status(tx, *task_id, "expired", ledger).await?;
        }
        Event::TaskCancelled { task_id, .. } => {
            set_task_status(tx, *task_id, "cancelled", ledger).await?;
        }
        Event::RewardIncreased {
            task_id,
            new_reward,
        } => {
            // The event carries the new TOTAL, not a delta (events.rs).
            sqlx::query(
                "update tasks set reward = $2::numeric, updated_ledger = $3 where task_id = $1",
            )
            .bind(*task_id as i64)
            .bind(new_reward.to_string())
            .bind(ledger as i64)
            .execute(&mut *tx)
            .await?;
        }
        Event::DeadlineExtended {
            task_id,
            new_deadline,
        } => {
            sqlx::query("update tasks set deadline = $2, updated_ledger = $3 where task_id = $1")
                .bind(*task_id as i64)
                .bind(*new_deadline as i64)
                .bind(ledger as i64)
                .execute(&mut *tx)
                .await?;
        }
        // Admin-facing events currently project onto nothing here: their
        // current-state table is 0222's. The raw row is their record.
        Event::Paused { .. }
        | Event::FeeUpdated { .. }
        | Event::AdminTransferred { .. }
        | Event::MinRewardUpdated { .. }
        | Event::FeesSwept { .. }
        | Event::Initialized { .. }
        | Event::Upgraded { .. } => {}
    }
    Ok(())
}

async fn set_task_status(
    tx: &mut sqlx::PgConnection,
    task_id: u64,
    status: &str,
    ledger: u32,
) -> Result<(), sqlx::Error> {
    sqlx::query("update tasks set status = $2, updated_ledger = $3 where task_id = $1")
        .bind(task_id as i64)
        .bind(status)
        .bind(ledger as i64)
        .execute(&mut *tx)
        .await?;
    Ok(())
}
