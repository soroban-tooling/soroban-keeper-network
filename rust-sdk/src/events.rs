//! Typed event decoders for all Keeper Registry contract events (Issue #336).

use soroban_sdk::{Address, Bytes, Symbol};

#[derive(Debug, Clone, PartialEq)]
pub struct TaskRegisteredEvent {
    pub task_id: u64,
    pub owner: Address,
    pub reward: i128,
    pub deadline: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskClaimedEvent {
    pub task_id: u64,
    pub keeper: Address,
    pub ledger_sequence: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskExecutedEvent {
    pub task_id: u64,
    pub keeper: Address,
    pub net_reward: i128,
    pub proof: Bytes,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskExpiredEvent {
    pub task_id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskCancelledEvent {
    pub task_id: u64,
    pub owner: Address,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RewardsWithdrawnEvent {
    pub keeper: Address,
    pub amount: i128,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PausedEvent {
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FeesSweptEvent {
    pub recipient: Address,
    pub amount: i128,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub reward_token: Address,
    pub fee_bps: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KeeperEvent {
    TaskRegistered(TaskRegisteredEvent),
    TaskClaimed(TaskClaimedEvent),
    TaskExecuted(TaskExecutedEvent),
    TaskExpired(TaskExpiredEvent),
    TaskCancelled(TaskCancelledEvent),
    RewardsWithdrawn(RewardsWithdrawnEvent),
    Paused(PausedEvent),
    FeesSwept(FeesSweptEvent),
    Initialized(InitializedEvent),
}

#[derive(Debug, thiserror::Error)]
pub enum EventDecodeError {
    #[error("Unknown event topic: ({0:?}, {1:?})")]
    UnknownTopic(Symbol, Symbol),
    #[error("Malformed event payload")]
    MalformedPayload,
}
