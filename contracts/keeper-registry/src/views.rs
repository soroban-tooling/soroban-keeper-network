//! Read-only views.
//!
//! These are simulated by clients for free and must stay side-effect-free —
//! in particular they never bump storage TTL. See `internal::bump_instance`.

use soroban_sdk::{contractimpl, Address, Env};

use crate::constants::*;
use crate::errors::KeeperError;
use crate::internal::*;
use crate::types::{DataKey, Task, TaskStatus};
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

#[contractimpl]
impl KeeperRegistry {
    /// Read-only: protocol fees accrued and awaiting sweep.
    pub fn fees_accrued(e: Env) -> i128 {
        e.storage()
            .instance()
            .get(&DataKey::FeesAccrued)
            .unwrap_or(0)
    }
    // ── Read-only views ───────────────────────────────────────────────────────
    //
    // Policy: views never return NotInitialized. Unlike a state-changing call,
    // a view on an uninitialized registry has an unambiguous, harmless answer
    // (zero tasks, zero balance, not paused, no admin configured) rather than
    // an operation that would silently do the wrong thing — `admin()` already
    // reflects this by returning `Option::None`, and `task_count`/`is_paused`/
    // `fees_accrued` return their natural default. Please keep this policy
    // rather than "fixing" these to error, so views stay side-effect-free and
    // safe to call speculatively (e.g. by a keeper bot probing a fresh
    // deployment before it knows whether `initialize` has run).

    pub fn get_task(e: Env, task_id: u64) -> Result<Task, KeeperError> {
        load_task(&e, task_id)
    }
    pub fn task_count(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&DataKey::TaskCounter)
            .unwrap_or(0u64)
    }
    /// Read-only: a keeper's withdrawable balance.
    ///
    /// TTL note: `KeeperReward(addr)` is only renewed when the balance is
    /// written — credited in `execute_task`/`credit_keeper`, or zeroed in
    /// `withdraw_rewards`. A keeper that executes exactly one task and never
    /// interacts with the contract again has a balance entry whose TTL is
    /// never touched afterward, so it *can* be archived like any other
    /// persistent entry. This view does not renew it on read: views are
    /// simulated by clients for free and must stay side-effect-free (same
    /// choice as instance storage, see `bump_instance`). An archived balance
    /// entry must be restored (RestoreFootprint) before it can be read or
    /// withdrawn again — the entry is not lost, just inaccessible until
    /// restored, and its value is preserved.
    pub fn keeper_balance(e: Env, keeper: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::KeeperReward(keeper))
            .unwrap_or(0i128)
    }
    pub fn admin(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::Admin)
    }
    pub fn get_fee_bps(e: Env) -> u32 {
        fee_bps(&e)
    }
    pub fn is_paused(e: Env) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }
    pub fn reward_token_address(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::RewardToken)
    }
    /// True if the task can be claimed right now: it exists, its deadline has
    /// not passed, and it is either Pending or a Claimed task whose lock window
    /// has elapsed. Lets keeper bots pre-filter candidates without simulating a
    /// full claim_task call.
    pub fn is_claimable(e: Env, task_id: u64) -> bool {
        match load_task(&e, task_id) {
            Ok(task) => {
                if e.ledger().timestamp() >= task.deadline {
                    return false;
                }
                match task.status {
                    TaskStatus::Pending => true,
                    TaskStatus::Claimed => lock_expired(&e, &task),
                    _ => false,
                }
            }
            Err(_) => false,
        }
    }
    /// Minimum reward required to register a task (0 if unset).
    pub fn min_reward(e: Env) -> i128 {
        min_reward_floor(&e)
    }
    /// Maximum number of entries `batch_register_tasks` accepts. See
    /// [`MAX_BATCH_SIZE`] — exposed so integrators can chunk their worklists
    /// against the deployed contract's real cap rather than a hardcoded guess.
    pub fn max_batch_size(_e: Env) -> u32 {
        MAX_BATCH_SIZE
    }
    /// Contract logic version. See [`VERSION`].
    pub fn version(_e: Env) -> u32 {
        VERSION
    }
    /// Read-only: a keeper's currently-bonded stake (E06,
    /// docs/STAKING_DESIGN.md). Excludes anything mid-unbond — see
    /// [`KeeperRegistry::pending_unbond`]. Mirrors `keeper_balance`'s shape
    /// and TTL policy (not renewed on read).
    pub fn keeper_stake(e: Env, keeper: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::KeeperStake(keeper))
            .unwrap_or(0i128)
    }
    /// Read-only: a keeper's pending unbond request, if any.
    pub fn pending_unbond(e: Env, keeper: Address) -> Option<crate::types::UnbondRequest> {
        e.storage()
            .persistent()
            .get(&DataKey::UnbondRequest(keeper))
    }
    /// Minimum bonded stake `claim_task` requires (0 if unset — no
    /// requirement). See docs/STAKING_DESIGN.md §6.
    pub fn min_stake(e: Env) -> i128 {
        min_stake_floor(&e)
    }
    /// Read-only: a specific slash record by id, if it still exists (a
    /// resolved appeal removes its record — see `resolve_slash_appeal`).
    pub fn get_slash(e: Env, slash_id: u64) -> Option<crate::types::SlashRecord> {
        e.storage().persistent().get(&DataKey::Slash(slash_id))
    }
    /// Ledgers an execute_task credit is held before it becomes
    /// withdrawable (0 if unset — disabled). See docs/STAKING_DESIGN.md §4.2.
    pub fn dispute_window(e: Env) -> u32 {
        dispute_window_ledgers(&e)
    }
    /// Read-only: a keeper's not-yet-finalized execute_task credits.
    pub fn pending_reward(
        e: Env,
        keeper: Address,
    ) -> soroban_sdk::Vec<crate::types::PendingCredit> {
        pending_credits_of(&e, &keeper)
    }
}
