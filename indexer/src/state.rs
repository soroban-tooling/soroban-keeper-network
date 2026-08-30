//! State derived by folding event history.
//!
//! Nothing here is stored as mutable state. A task's status, a keeper's
//! balance and the live admin config are all recomputed from the append-only
//! event log, so they cannot drift from the events that produced them. Each
//! fold mirrors a contract view: [`TaskState`] mirrors `get_task`,
//! [`KeeperSummary::credited_balance`] mirrors `keeper_balance`, and
//! [`AdminConfig`] mirrors `admin`/`get_fee_bps`/`is_paused`/`min_reward`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::events::{EventPayload, IndexedEvent, I128};

/// Lifecycle state of a task, named to match the contract's `TaskStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Claimed,
    Executed,
    Cancelled,
    Expired,
}

/// A task's current state, folded from its event history.
///
/// Only fields the events actually carry are present. The contract's `Task`
/// struct also holds `task_type`, `calldata`, `ttl_ledgers` and
/// `lock_ledgers`, but no event emits them, so they are not reconstructed
/// here rather than being guessed at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct TaskState {
    pub task_id: u64,
    pub owner: String,
    pub status: TaskStatus,
    /// Live reward: the registered reward with every `RewardIncreased` folded in.
    #[schema(value_type = String)]
    pub reward: I128,
    /// Live deadline: the registered deadline with every `DeadlineExtended` applied.
    pub deadline: u64,
    /// Keeper holding the claim, once claimed.
    pub keeper: Option<String>,
    /// Ledger the claim was taken at.
    pub claim_ledger: Option<u32>,
    /// Net reward paid on execution, once executed.
    #[schema(value_type = String)]
    pub net_reward: Option<I128>,
    /// Ledger of the most recent event for this task.
    pub last_ledger: u32,
}

impl TaskState {
    /// Fold a task's history into its current state.
    ///
    /// Returns `None` until a `TaskRegistered` is seen: without it there is no
    /// owner or reward to speak of, and inventing one would be exactly the
    /// reconstruction the schema design warns against.
    pub fn fold(task_id: u64, history: &[IndexedEvent]) -> Option<Self> {
        let mut state: Option<Self> = None;

        for event in history {
            match &event.payload {
                EventPayload::TaskRegistered {
                    owner,
                    reward,
                    deadline,
                    ..
                } => {
                    state = Some(Self {
                        task_id,
                        owner: owner.clone(),
                        status: TaskStatus::Pending,
                        reward: *reward,
                        deadline: *deadline,
                        keeper: None,
                        claim_ledger: None,
                        net_reward: None,
                        last_ledger: event.ledger,
                    });
                }
                other => {
                    let Some(state) = state.as_mut() else {
                        // An event for a task whose registration has not been
                        // ingested yet: skip rather than fabricate a task.
                        continue;
                    };
                    match other {
                        EventPayload::TaskClaimed {
                            keeper,
                            claim_ledger,
                            ..
                        } => {
                            state.status = TaskStatus::Claimed;
                            state.keeper = Some(keeper.clone());
                            state.claim_ledger = Some(*claim_ledger);
                        }
                        EventPayload::TaskExecuted {
                            keeper, net_reward, ..
                        } => {
                            state.status = TaskStatus::Executed;
                            state.keeper = Some(keeper.clone());
                            state.net_reward = Some(*net_reward);
                        }
                        EventPayload::TaskExpired { .. } => state.status = TaskStatus::Expired,
                        EventPayload::TaskCancelled { .. } => state.status = TaskStatus::Cancelled,
                        // The contract emits the resulting total, not a delta,
                        // so the latest value wins rather than accumulating.
                        EventPayload::RewardIncreased { new_reward, .. } => {
                            state.reward = *new_reward;
                        }
                        EventPayload::DeadlineExtended { new_deadline, .. } => {
                            state.deadline = *new_deadline;
                        }
                        _ => continue,
                    }
                    state.last_ledger = event.ledger;
                }
            }
        }

        state
    }
}

/// Everything the indexer knows about one keeper address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct KeeperSummary {
    pub keeper: String,
    /// Tasks this keeper has claimed.
    pub claimed_task_ids: Vec<u64>,
    /// Tasks this keeper has executed.
    pub executed_task_ids: Vec<u64>,
    /// Sum of `net_reward` across every execution.
    #[schema(value_type = String)]
    pub total_earned: I128,
    /// Sum of every `RewardsWithdrawn` amount.
    #[schema(value_type = String)]
    pub total_withdrawn: I128,
    /// Earned minus withdrawn.
    ///
    /// This is the figure the contract's `keeper_balance` view reports once
    /// the indexer is caught up. Exposed as its own field so no consumer has
    /// to recompute it.
    #[schema(value_type = String)]
    pub credited_balance: I128,
}

impl KeeperSummary {
    /// Fold a keeper's events into their summary.
    pub fn fold(keeper: &str, events: &[IndexedEvent]) -> Self {
        let mut claimed_task_ids = Vec::new();
        let mut executed_task_ids = Vec::new();
        let mut total_earned = 0i128;
        let mut total_withdrawn = 0i128;

        for event in events {
            match &event.payload {
                EventPayload::TaskClaimed { task_id, .. } => claimed_task_ids.push(*task_id),
                EventPayload::TaskExecuted {
                    task_id,
                    net_reward,
                    ..
                } => {
                    executed_task_ids.push(*task_id);
                    total_earned += net_reward.0;
                }
                EventPayload::RewardsWithdrawn { amount, .. } => total_withdrawn += amount.0,
                _ => {}
            }
        }

        Self {
            keeper: keeper.to_string(),
            claimed_task_ids,
            executed_task_ids,
            total_earned: I128(total_earned),
            total_withdrawn: I128(total_withdrawn),
            credited_balance: I128(total_earned - total_withdrawn),
        }
    }
}

/// The registry's current configuration, folded from admin event history.
///
/// Every field is `Option` because the indexer may not have ingested the event
/// that would set it: reporting `None` is honest, where a default would be a
/// value the contract never emitted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AdminConfig {
    pub admin: Option<String>,
    pub reward_token: Option<String>,
    pub fee_bps: Option<u32>,
    pub paused: Option<bool>,
    #[schema(value_type = Option<String>)]
    pub min_reward: Option<I128>,
    /// Fees swept to a treasury so far, summed across every `FeesSwept`.
    #[schema(value_type = String)]
    pub total_fees_swept: I128,
    /// Most recent wasm hash from an `Upgraded` event, hex-encoded.
    pub current_wasm_hash: Option<String>,
}

impl AdminConfig {
    /// Fold the admin event history into the live configuration.
    ///
    /// Later events of the same kind supersede earlier ones, which is what
    /// makes this a current-config view; the full history stays queryable
    /// through the event feed.
    pub fn fold(events: &[IndexedEvent]) -> Self {
        let mut config = Self::default();
        let mut swept = 0i128;

        for event in events {
            match &event.payload {
                EventPayload::Initialized {
                    admin,
                    reward_token,
                    fee_bps,
                } => {
                    config.admin = Some(admin.clone());
                    config.reward_token = Some(reward_token.clone());
                    config.fee_bps = Some(*fee_bps);
                    // The contract starts unpaused; the Initialized event is
                    // the first point at which that is known to be true.
                    config.paused.get_or_insert(false);
                }
                EventPayload::Paused { paused } => config.paused = Some(*paused),
                EventPayload::FeeUpdated { new_bps, .. } => config.fee_bps = Some(*new_bps),
                EventPayload::AdminTransferred { new_admin, .. } => {
                    config.admin = Some(new_admin.clone());
                }
                EventPayload::MinRewardUpdated { new_min, .. } => {
                    config.min_reward = Some(*new_min);
                }
                EventPayload::FeesSwept { amount, .. } => swept += amount.0,
                EventPayload::Upgraded { new_wasm_hash, .. } => {
                    config.current_wasm_hash = Some(new_wasm_hash.clone());
                }
                _ => {}
            }
        }

        config.total_fees_swept = I128(swept);
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventType;

    fn event(ledger: u32, cursor: i64, payload: EventPayload) -> IndexedEvent {
        IndexedEvent {
            cursor,
            ledger,
            ledger_close_time: i64::from(ledger) * 5,
            tx_hash: format!("tx{cursor}"),
            event_index: 0,
            event_type: payload.event_type(),
            payload,
        }
    }

    #[test]
    fn a_task_with_no_registration_yields_no_state() {
        let history = vec![event(5, 1, EventPayload::TaskExpired { task_id: 1 })];
        assert_eq!(TaskState::fold(1, &history), None);
    }

    #[test]
    fn reward_increases_and_deadline_extensions_fold_into_live_values() {
        let history = vec![
            event(
                1,
                1,
                EventPayload::TaskRegistered {
                    task_id: 1,
                    owner: "GOWNER".into(),
                    reward: I128(100),
                    deadline: 1_000,
                },
            ),
            event(
                2,
                2,
                EventPayload::RewardIncreased {
                    task_id: 1,
                    new_reward: I128(150),
                },
            ),
            event(
                3,
                3,
                EventPayload::RewardIncreased {
                    task_id: 1,
                    new_reward: I128(220),
                },
            ),
            event(
                4,
                4,
                EventPayload::DeadlineExtended {
                    task_id: 1,
                    new_deadline: 2_000,
                },
            ),
        ];

        let state = TaskState::fold(1, &history).expect("registered task");
        // The contract emits the resulting total, so the newest value is live
        // -- not 100 + 150 + 220.
        assert_eq!(state.reward, I128(220));
        assert_eq!(state.deadline, 2_000);
        assert_eq!(state.status, TaskStatus::Pending);
    }

    #[test]
    fn the_full_lifecycle_ends_executed_with_its_net_reward() {
        let history = vec![
            event(
                1,
                1,
                EventPayload::TaskRegistered {
                    task_id: 9,
                    owner: "GOWNER".into(),
                    reward: I128(1_000),
                    deadline: 5_000,
                },
            ),
            event(
                2,
                2,
                EventPayload::TaskClaimed {
                    task_id: 9,
                    keeper: "GKEEPER".into(),
                    claim_ledger: 2,
                },
            ),
            event(
                3,
                3,
                EventPayload::TaskExecuted {
                    task_id: 9,
                    keeper: "GKEEPER".into(),
                    net_reward: I128(990),
                    proof: "beef".into(),
                },
            ),
        ];

        let state = TaskState::fold(9, &history).expect("registered task");
        assert_eq!(state.status, TaskStatus::Executed);
        assert_eq!(state.keeper.as_deref(), Some("GKEEPER"));
        assert_eq!(state.claim_ledger, Some(2));
        assert_eq!(state.net_reward, Some(I128(990)));
        // Escrowed reward and net payout are distinct: the fee is the gap.
        assert_eq!(state.reward, I128(1_000));
    }

    #[test]
    fn cancellation_and_expiry_are_terminal_states() {
        let base = event(
            1,
            1,
            EventPayload::TaskRegistered {
                task_id: 3,
                owner: "GOWNER".into(),
                reward: I128(10),
                deadline: 100,
            },
        );

        let cancelled = vec![
            base.clone(),
            event(
                2,
                2,
                EventPayload::TaskCancelled {
                    task_id: 3,
                    owner: "GOWNER".into(),
                },
            ),
        ];
        assert_eq!(
            TaskState::fold(3, &cancelled).expect("state").status,
            TaskStatus::Cancelled
        );

        let expired = vec![base, event(2, 2, EventPayload::TaskExpired { task_id: 3 })];
        assert_eq!(
            TaskState::fold(3, &expired).expect("state").status,
            TaskStatus::Expired
        );
    }

    #[test]
    fn keeper_balance_is_executions_minus_withdrawals() {
        let events = vec![
            event(
                1,
                1,
                EventPayload::TaskExecuted {
                    task_id: 1,
                    keeper: "GKEEPER".into(),
                    net_reward: I128(500),
                    proof: "00".into(),
                },
            ),
            event(
                2,
                2,
                EventPayload::TaskExecuted {
                    task_id: 2,
                    keeper: "GKEEPER".into(),
                    net_reward: I128(300),
                    proof: "00".into(),
                },
            ),
            event(
                3,
                3,
                EventPayload::RewardsWithdrawn {
                    keeper: "GKEEPER".into(),
                    amount: I128(600),
                },
            ),
        ];

        let summary = KeeperSummary::fold("GKEEPER", &events);
        assert_eq!(summary.total_earned, I128(800));
        assert_eq!(summary.total_withdrawn, I128(600));
        // What the contract's keeper_balance view would report.
        assert_eq!(summary.credited_balance, I128(200));
        assert_eq!(summary.executed_task_ids, vec![1, 2]);
    }

    #[test]
    fn admin_config_reflects_the_latest_of_each_event_kind() {
        let events = vec![
            event(
                1,
                1,
                EventPayload::Initialized {
                    admin: "GADMIN1".into(),
                    reward_token: "GTOKEN".into(),
                    fee_bps: 100,
                },
            ),
            event(
                2,
                2,
                EventPayload::FeeUpdated {
                    old_bps: 100,
                    new_bps: 250,
                },
            ),
            event(
                3,
                3,
                EventPayload::FeeUpdated {
                    old_bps: 250,
                    new_bps: 300,
                },
            ),
            event(
                4,
                4,
                EventPayload::AdminTransferred {
                    old_admin: "GADMIN1".into(),
                    new_admin: "GADMIN2".into(),
                },
            ),
            event(5, 5, EventPayload::Paused { paused: true }),
            event(
                6,
                6,
                EventPayload::MinRewardUpdated {
                    old_min: I128(0),
                    new_min: I128(42),
                },
            ),
            event(
                7,
                7,
                EventPayload::FeesSwept {
                    treasury: "GTREASURY".into(),
                    amount: I128(70),
                    remaining: I128(0),
                },
            ),
            event(
                8,
                8,
                EventPayload::FeesSwept {
                    treasury: "GTREASURY".into(),
                    amount: I128(30),
                    remaining: I128(0),
                },
            ),
        ];

        let config = AdminConfig::fold(&events);
        assert_eq!(config.fee_bps, Some(300));
        assert_eq!(config.admin.as_deref(), Some("GADMIN2"));
        assert_eq!(config.paused, Some(true));
        assert_eq!(config.min_reward, Some(I128(42)));
        // Sweeps accumulate; they are not a "latest value wins" field.
        assert_eq!(config.total_fees_swept, I128(100));
    }

    #[test]
    fn an_uninitialised_indexer_reports_unknown_rather_than_defaults() {
        let config = AdminConfig::fold(&[]);
        assert_eq!(config.admin, None);
        assert_eq!(config.fee_bps, None);
        // Not Some(false): the indexer has not seen evidence either way.
        assert_eq!(config.paused, None);
    }

    #[test]
    fn event_type_matches_payload_for_every_folded_event() {
        let registered = event(
            1,
            1,
            EventPayload::TaskRegistered {
                task_id: 1,
                owner: "GOWNER".into(),
                reward: I128(1),
                deadline: 1,
            },
        );
        assert_eq!(registered.event_type, EventType::TaskRegistered);
    }
}
