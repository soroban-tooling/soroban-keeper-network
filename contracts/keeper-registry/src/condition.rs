//! The task condition interface contracts may implement.
//!
//! Design rationale, interface specification, and gas cost semantics:
//! `docs/TASK_CONDITIONS_DESIGN.md` (epic E10).

use soroban_sdk::{contractclient, Address, Env};

/// Implemented by any contract a task owner wants to use as a per-task
/// condition predicate, attached via `register_task`'s optional `condition`
/// parameter. `claim_task` calls this — through the generated
/// `TaskConditionClient`'s `try_check`, which catches a callee panic rather
/// than propagating it — before allowing a claim. If it returns `false`, the
/// task remains `Pending` and unclaimed, retryable once the condition later
/// becomes `true`. See `docs/TASK_CONDITIONS_DESIGN.md`.
///
/// Distinct from `IKeeperVerifier` (E04), which gates `execute_task` after a
/// claim has been made, checking a proof. This gates `claim_task` before any
/// off-chain work happens, checking only whether the task is worth attempting
/// at all.
#[contractclient(name = "TaskConditionClient")]
pub trait ITaskCondition {
    /// Returns `true` if the on-chain condition the task exists to react to is
    /// currently satisfied, `false` otherwise.
    ///
    /// Must not panic on a temporary failure — return `false`. A panic is
    /// reserved for the condition being fundamentally broken, and
    /// `claim_task` treats it as equivalent to `false` regardless.
    fn check(env: Env, task_id: u64) -> bool;
}
