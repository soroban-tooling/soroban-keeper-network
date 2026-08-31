//! Ingestion for task lifecycle events (issue #348).
//!
//! Handles `TaskRegistered`, `TaskClaimed`, `TaskExecuted`, `TaskExpired`,
//! `TaskCancelled`, `RewardIncreased`, and `DeadlineExtended`.
//!
//! Every event becomes an immutable row in `task_events`. The current state
//! of a task is derived by folding its full event history in chronological order.

use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Column list shared by task event inserts.
const INSERT_SQL: &str = "
    INSERT INTO task_events (
        ledger, tx_index, event_index, kind, task_id,
        owner, keeper, reward, net_reward, deadline, claim_ledger, proof
    ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8::text::numeric, $9::text::numeric, $10, $11, $12
    )
    ON CONFLICT (ledger, tx_index, event_index) DO NOTHING";

/// Apply one event to `task_events`.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;

    let kind: &str;
    let task_id: i64;
    let mut owner: Option<String> = None;
    let mut keeper: Option<String> = None;
    let mut reward: Option<String> = None;
    let mut net_reward: Option<String> = None;
    let mut deadline: Option<i64> = None;
    let mut claim_ledger: Option<i64> = None;
    let mut proof: Option<Vec<u8>> = None;

    match &event.payload {
        EventPayload::TaskRegistered {
            task_id: id,
            owner: o,
            reward: r,
            deadline: d,
        } => {
            kind = "registered";
            task_id = *id;
            owner = Some(o.clone());
            reward = Some(i128_to_sql(*r));
            deadline = Some(*d as i64);
        }
        EventPayload::TaskClaimed {
            task_id: id,
            keeper: k,
            claim_ledger: cl,
        } => {
            kind = "claimed";
            task_id = *id;
            keeper = Some(k.clone());
            claim_ledger = Some(*cl as i64);
        }
        EventPayload::TaskExecuted {
            task_id: id,
            keeper: k,
            net_reward: nr,
            proof: p,
        } => {
            kind = "executed";
            task_id = *id;
            keeper = Some(k.clone());
            net_reward = Some(i128_to_sql(*nr));
            proof = Some(p.clone());
        }
        EventPayload::TaskExpired { task_id: id } => {
            kind = "expired";
            task_id = *id;
        }
        EventPayload::TaskCancelled {
            task_id: id,
            owner: o,
        } => {
            kind = "cancelled";
            task_id = *id;
            owner = Some(o.clone());
        }
        EventPayload::RewardIncreased {
            task_id: id,
            new_reward: nr,
        } => {
            kind = "reward_increased";
            task_id = *id;
            reward = Some(i128_to_sql(*nr));
        }
        EventPayload::DeadlineExtended {
            task_id: id,
            new_deadline: nd,
        } => {
            kind = "deadline_extended";
            task_id = *id;
            deadline = Some(*nd as i64);
        }
        _ => return Ok(()),
    }

    client
        .execute(
            INSERT_SQL,
            &[
                &(c.ledger as i64),
                &(c.tx_index as i64),
                &(c.event_index as i64),
                &kind,
                &task_id,
                &owner,
                &keeper,
                &reward,
                &net_reward,
                &deadline,
                &claim_ledger,
                &proof,
            ],
        )
        .await?;

    Ok(())
}

/// One observed event row for a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEventRow {
    pub ledger: u32,
    pub tx_index: u32,
    pub event_index: u32,
    pub kind: String,
    pub task_id: i64,
    pub owner: Option<String>,
    pub keeper: Option<String>,
    pub reward: Option<i128>,
    pub net_reward: Option<i128>,
    pub deadline: Option<u64>,
    pub claim_ledger: Option<u32>,
    pub proof: Option<Vec<u8>>,
}

/// Derived current state of a task.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskState {
    pub task_id: i64,
    pub owner: String,
    pub status: String,
    pub reward: i128,
    pub deadline: u64,
    pub keeper: Option<String>,
    pub claim_ledger: Option<u32>,
    pub net_reward: Option<i128>,
    pub last_ledger: u32,
}

impl TaskState {
    /// Fold a task's history rows into its current live state.
    pub fn fold(task_id: i64, history: &[TaskEventRow]) -> Option<Self> {
        let mut state: Option<Self> = None;

        for event in history {
            match event.kind.as_str() {
                "registered" => {
                    if let (Some(owner), Some(reward), Some(deadline)) =
                        (&event.owner, event.reward, event.deadline)
                    {
                        state = Some(Self {
                            task_id,
                            owner: owner.clone(),
                            status: "pending".to_string(),
                            reward,
                            deadline,
                            keeper: None,
                            claim_ledger: None,
                            net_reward: None,
                            last_ledger: event.ledger,
                        });
                    }
                }
                _ => {
                    let Some(s) = state.as_mut() else {
                        continue;
                    };
                    match event.kind.as_str() {
                        "claimed" => {
                            s.status = "claimed".to_string();
                            s.keeper = event.keeper.clone();
                            s.claim_ledger = event.claim_ledger;
                        }
                        "executed" => {
                            s.status = "executed".to_string();
                            s.keeper = event.keeper.clone();
                            s.net_reward = event.net_reward;
                        }
                        "expired" => s.status = "expired".to_string(),
                        "cancelled" => s.status = "cancelled".to_string(),
                        "reward_increased" => {
                            if let Some(r) = event.reward {
                                s.reward = r;
                            }
                        }
                        "deadline_extended" => {
                            if let Some(d) = event.deadline {
                                s.deadline = d;
                            }
                        }
                        _ => {}
                    }
                    s.last_ledger = event.ledger;
                }
            }
        }

        state
    }
}

/// Query full event history for a single task id in chronological order.
pub async fn task_history(
    client: &Client,
    task_id: i64,
) -> Result<Vec<TaskEventRow>, IndexerError> {
    let rows = client
        .query(
            "SELECT ledger, tx_index, event_index, kind, task_id, owner, keeper,
                    reward::text, net_reward::text, deadline, claim_ledger, proof
               FROM task_events
              WHERE task_id = $1
              ORDER BY ledger ASC, tx_index ASC, event_index ASC",
            &[&task_id],
        )
        .await?;

    let mut result = Vec::with_capacity(rows.len());
    for r in rows {
        let reward_str: Option<String> = r.get(7);
        let net_reward_str: Option<String> = r.get(8);

        let reward = match reward_str {
            Some(s) => Some(i128_from_sql(&s)?),
            None => None,
        };
        let net_reward = match net_reward_str {
            Some(s) => Some(i128_from_sql(&s)?),
            None => None,
        };

        result.push(TaskEventRow {
            ledger: r.get::<_, i64>(0) as u32,
            tx_index: r.get::<_, i64>(1) as u32,
            event_index: r.get::<_, i64>(2) as u32,
            kind: r.get(3),
            task_id: r.get(4),
            owner: r.get(5),
            keeper: r.get(6),
            reward,
            net_reward,
            deadline: r.get::<_, Option<i64>>(9).map(|d| d as u64),
            claim_ledger: r.get::<_, Option<i64>>(10).map(|cl| cl as u32),
            proof: r.get(11),
        });
    }

    Ok(result)
}

/// Query the derived current state for a single task id.
pub async fn task_state(
    client: &Client,
    task_id: i64,
) -> Result<Option<TaskState>, IndexerError> {
    let history = task_history(client, task_id).await?;
    Ok(TaskState::fold(task_id, &history))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_state_folding_reward_and_deadline() {
        let history = vec![
            TaskEventRow {
                ledger: 1,
                tx_index: 0,
                event_index: 0,
                kind: "registered".to_string(),
                task_id: 42,
                owner: Some("GOWNER".to_string()),
                keeper: None,
                reward: Some(1_000),
                net_reward: None,
                deadline: Some(5_000),
                claim_ledger: None,
                proof: None,
            },
            TaskEventRow {
                ledger: 2,
                tx_index: 0,
                event_index: 0,
                kind: "reward_increased".to_string(),
                task_id: 42,
                owner: None,
                keeper: None,
                reward: Some(1_500),
                net_reward: None,
                deadline: None,
                claim_ledger: None,
                proof: None,
            },
            TaskEventRow {
                ledger: 3,
                tx_index: 0,
                event_index: 0,
                kind: "deadline_extended".to_string(),
                task_id: 42,
                owner: None,
                keeper: None,
                reward: None,
                net_reward: None,
                deadline: Some(10_000),
                claim_ledger: None,
                proof: None,
            },
            TaskEventRow {
                ledger: 4,
                tx_index: 0,
                event_index: 0,
                kind: "claimed".to_string(),
                task_id: 42,
                owner: None,
                keeper: Some("GKEEPER".to_string()),
                reward: None,
                net_reward: None,
                deadline: None,
                claim_ledger: Some(4),
                proof: None,
            },
        ];

        let state = TaskState::fold(42, &history).expect("task state");
        assert_eq!(state.task_id, 42);
        assert_eq!(state.owner, "GOWNER");
        assert_eq!(state.status, "claimed");
        assert_eq!(state.reward, 1_500);
        assert_eq!(state.deadline, 10_000);
        assert_eq!(state.keeper.as_deref(), Some("GKEEPER"));
        assert_eq!(state.claim_ledger, Some(4));
        assert_eq!(state.last_ledger, 4);
    }
}
