//! The task-condition interface implemented by contracts that gate claiming.
//!
//! Conditions run before any claim state is written. A condition must return
//! `true` only while the task is worth claiming. `false`, a malformed return,
//! or a callee failure all reject the claim without changing the task.

use soroban_sdk::{contractclient, Env};

#[contractclient(name = "TaskConditionClient")]
pub trait ITaskCondition {
    /// Whether `task_id` may be claimed at the current ledger state.
    fn is_met(env: Env, task_id: u64) -> bool;
}
