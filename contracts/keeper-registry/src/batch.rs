//! Batch registration and batch reads.
//!
//! Semantics are specified in `docs/BATCH_OPERATIONS.md`: one auth per batch,
//! whole-batch atomicity, an explicit size ceiling, and positionally aligned
//! results that error rather than truncate.

use soroban_sdk::{contractimpl, log, Address, Env, Vec};

use crate::constants::*;
use crate::errors::KeeperError;
use crate::events::*;
use crate::internal::*;
use crate::types::{BatchTaskParams, Task, TaskStatus};
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

#[contractimpl]
impl KeeperRegistry {
    // ── batch_register_tasks ─────────────────────────────────────────────────
    //
    // Registers every entry in `tasks` under a single owner auth, amortizing
    // the fixed per-call overhead `register_task` pays N times over N separate
    // transactions. The full design rationale — auth model, partial-failure
    // semantics, the resource ceiling, and integrator guidance on sizing
    // `max_total_reward` — lives in docs/BATCH_OPERATIONS.md.
    //
    // Arguments:
    //   owner            — address funding every task in the batch (auths once)
    //   tasks            — 1..=MAX_BATCH_SIZE entries, each validated exactly
    //                      as `register_task` validates its arguments
    //   max_total_reward — caller-reviewed ceiling on the escrow this call may
    //                      pull. Set it to the exact sum of the batch; padding
    //                      only widens the window in which the call could move
    //                      more than was reviewed (docs §7).
    //
    // Returns the new task ids, in the same order as `tasks`.

    pub fn batch_register_tasks(
        e: Env,
        owner: Address,
        tasks: Vec<BatchTaskParams>,
        max_total_reward: i128,
    ) -> Result<Vec<u64>, KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        if tasks.is_empty() {
            return Err(KeeperError::EmptyBatch);
        }
        if tasks.len() > MAX_BATCH_SIZE {
            return Err(KeeperError::BatchTooLarge);
        }
        if max_total_reward <= 0 {
            return Err(KeeperError::InvalidReward);
        }

        // Validate every entry and total the rewards BEFORE moving any funds.
        // Whole-batch atomicity (docs §3) means a rejection here leaves zero
        // transfers and zero tasks behind — but doing the full sweep up front
        // also means a batch that will be rejected never pays for a single
        // cross-contract token transfer first.
        let min_reward = min_reward_floor(&e);
        let mut total_reward: i128 = 0;
        for params in tasks.iter() {
            validate_task_params(
                &e,
                params.reward,
                min_reward,
                params.deadline,
                params.calldata.len(),
                params.ttl_ledgers,
                params.lock_ledgers,
            )?;
            total_reward = total_reward
                .checked_add(params.reward)
                .ok_or(KeeperError::ArithmeticOverflow)?;
        }
        if total_reward > max_total_reward {
            return Err(KeeperError::BatchRewardCeilingExceeded);
        }

        bump_instance(&e);

        // One transfer per entry, matching `register_task`'s escrow-per-task
        // accounting: each task's reward must stay independently refundable by
        // `cancel_task`/`expire_task` later. Whether these N transfers can be
        // collapsed into one is analysed in docs/BATCH_OPERATIONS.md §9.
        let token = reward_token(&e)?;
        let registry = e.current_contract_address();
        let mut task_ids = Vec::new(&e);
        for params in tasks.iter() {
            token.transfer(&owner, &registry, &params.reward);

            let task_id = next_task_id(&e);
            let task = Task {
                owner: owner.clone(),
                task_type: params.task_type,
                calldata: params.calldata,
                reward: params.reward,
                deadline: params.deadline,
                ttl_ledgers: params.ttl_ledgers,
                verifier: None,
                status: TaskStatus::Pending,

                claimer: None,
                claim_ledger: None,
                lock_ledgers: params.lock_ledgers,
                // `BatchTaskParams` has no `verifier` field yet — attaching a
                // verifier to a batch-registered task is backlog issue 0102,
                // separate from this batch-registration slice.
                verifier: None,
            };
            save_task(&e, task_id, &task);
            emit_task_registered(&e, task_id, &owner, params.reward, params.deadline);
            task_ids.push_back(task_id);
        }

        log!(
            &e,
            "Batch registered {} tasks, total escrow {}",
            tasks.len(),
            total_reward
        );
        Ok(task_ids)
    }
    /// Reads up to [`MAX_BATCH_READ`] tasks in one call, so an indexer or
    /// keeper bot can inspect a set of tasks without one RPC round trip per
    /// task.
    ///
    /// **Missing ids.** The result is *positionally aligned* with `ids`: it has
    /// exactly `ids.len()` entries, and entry `i` is `Some(task)` if `ids[i]`
    /// exists and `None` if it does not. A single absent id therefore does not
    /// fail the whole call — a caller scanning a range does not need to know in
    /// advance which ids are live.
    ///
    /// `Vec<Option<Task>>` is used rather than a compacted `Vec<Task>` because
    /// [`Task`] does not carry its own `task_id`. Omitting missing ids from a
    /// bare `Vec<Task>` would make the mapping from result back to requested id
    /// unrecoverable — with two absent ids in a batch of ten, the caller cannot
    /// tell which eight it got. `None` is a void XDR variant, so the alignment
    /// costs almost nothing on the wire even for a sparse range.
    ///
    /// Returns [`KeeperError::BatchTooLarge`] if `ids` exceeds
    /// [`MAX_BATCH_READ`], rather than truncating: a silently clipped page is
    /// indistinguishable from the genuine end of a range.
    ///
    /// Duplicate ids are permitted and each is resolved independently; the
    /// caller pays for the repeated read.
    ///
    /// This does not violate the "no unbounded iteration" rule in the README.
    /// That rule is about *storage* — the contract keeps no growing
    /// `Vec<task_id>` that some operation must walk. Every read here is still
    /// O(1) by key against `DataKey::Task(id)`; the caller supplies the keys
    /// and the count is bounded by a constant.
    pub fn get_tasks(e: Env, ids: Vec<u64>) -> Result<Vec<Option<Task>>, KeeperError> {
        if ids.len() > MAX_BATCH_READ {
            return Err(KeeperError::BatchTooLarge);
        }

        let mut out = Vec::new(&e);
        for id in ids.iter() {
            out.push_back(load_task(&e, id).ok());
        }
        Ok(out)
    }
    /// Reads the `count` tasks with ids `from, from + 1, …, from + count - 1`.
    ///
    /// The convenience form of [`KeeperRegistry::get_tasks`] for the common
    /// "scan recent tasks" case — a bot walking backwards from
    /// [`KeeperRegistry::task_count`] does not have to build a `Vec<u64>` just
    /// to describe a contiguous range. Same missing-id policy: the result has
    /// exactly `count` entries, positionally aligned with the range, and ids
    /// that were never allocated or have been archived come back as `None`.
    ///
    /// `count == 0` returns an empty vector. `count` above [`MAX_BATCH_READ`]
    /// returns [`KeeperError::BatchTooLarge`], and a range whose end would
    /// exceed `u64::MAX` returns [`KeeperError::ArithmeticOverflow`] rather
    /// than wrapping around to low ids.
    pub fn get_tasks_range(
        e: Env,
        from: u64,
        count: u32,
    ) -> Result<Vec<Option<Task>>, KeeperError> {
        if count > MAX_BATCH_READ {
            return Err(KeeperError::BatchTooLarge);
        }

        // Reject a wrapping range up front rather than letting `from + i`
        // overflow mid-loop and silently return unrelated low-numbered tasks.
        //
        // The bound checked is the LAST id actually read (`from + count - 1`),
        // not the exclusive end (`from + count`): a window ending exactly on
        // `u64::MAX` is perfectly readable, and checking the exclusive end
        // would reject it for an overflow that never happens.
        if count > 0 {
            from.checked_add(count as u64 - 1)
                .ok_or(KeeperError::ArithmeticOverflow)?;
        }

        let mut out = Vec::new(&e);
        for i in 0..count as u64 {
            out.push_back(load_task(&e, from + i).ok());
        }
        Ok(out)
    }
}
