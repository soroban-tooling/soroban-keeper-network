//! # Soroban Keeper Network — Keeper Registry Contract
//!
//! This is the on-chain coordination layer of the Soroban Keeper Network.
//! dApps register automation tasks (liquidations, oracle pushes, TTL extensions…)
//! with an XLM reward bounty. Permissionless keeper bots compete to execute them.
//!
//! ## What is implemented here (starter scope)
//! - All storage keys, types, errors, and events — the full schema
//! - `initialize` — deploy and configure the registry
//! - `register_task` — dApps deposit a reward and post a task
//! - Read-only view helpers — `get_task`, `task_count`, `is_paused`, etc.
//!
//! ## What contributors should implement
//! Every function marked `TODO(contributors)` below is an open issue.
//! See CONTRIBUTING.md and the GitHub Issues tab to pick one up.
//!
//! Recommended order for new contributors:
//!   1. `claim_task`        — first-come-first-served keeper locking
//!   2. `execute_task`      — proof submission + reward crediting
//!   3. `cancel_task`       — owner refund path
//!   4. `expire_task`       — permissionless deadline enforcement
//!   5. `withdraw_rewards`  — keeper pulls accumulated balance
//!   6. Admin functions     — pause, set_fee_bps, transfer_admin, upgrade
//!
//! ## Storage Layout
//! - Instance:   Admin, FeeBps, Paused, TaskCounter, RewardToken
//! - Persistent: Task(id) → Task struct, KeeperReward(address) → i128

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    log, symbol_short, token,
    Address, Bytes, BytesN, Env,
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage Keys
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    FeeBps,
    Paused,
    TaskCounter,
    RewardToken,
    Task(u64),
    KeeperReward(Address),
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/// The kind of automation this task represents.
/// Contributors: add new variants here as the network supports more use-cases.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TaskType {
    Liquidation        = 0,
    OraclePricePush    = 1,
    FundingRateUpdate  = 2,
    LiquidityRebalance = 3,
    TtlExtension       = 4,
    Custom             = 5,
}

/// Lifecycle state of a task. Transitions are enforced by each function.
///
/// ```text
/// PENDING ──claim──▶ CLAIMED ──execute──▶ EXECUTED
///    │                  │
///  cancel             expire (deadline passed)
///    ▼                  ▼
/// CANCELLED          EXPIRED
/// ```
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TaskStatus {
    Pending   = 0,
    Claimed   = 1,
    Executed  = 2,
    Cancelled = 3,
    Expired   = 4,
}

/// Full task record stored in Persistent storage.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Task {
    /// Address that registered and funded this task.
    pub owner: Address,
    pub task_type: TaskType,
    /// Arbitrary bytes the keeper uses to reconstruct the target call off-chain.
    pub calldata: Bytes,
    /// Reward escrowed in this contract (token units / XLM stroops).
    pub reward: i128,
    /// Unix timestamp (seconds) after which the task may be expired.
    pub deadline: u64,
    /// Ledger TTL for this storage entry.
    pub ttl_ledgers: u32,
    pub status: TaskStatus,
    /// Set when a keeper claims the task.
    pub claimer: Option<Address>,
    /// Ledger sequence at claim time — used to enforce the lock window.
    pub claim_ledger: Option<u32>,
    /// Ledgers the claimer holds exclusive rights before re-claim is allowed.
    pub lock_ledgers: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum KeeperError {
    AlreadyInitialized = 1,
    Unauthorized       = 2,
    ContractPaused     = 3,
    TaskNotFound       = 4,
    InvalidTaskStatus  = 5,
    DeadlinePassed     = 6,
    DeadlineNotPassed  = 7,
    InvalidReward      = 8,
    LockPeriodActive   = 9,
    InvalidFeeBps      = 10,
    NotTaskOwner       = 11,
    NotTaskClaimer     = 12,
    NoRewardsAvailable = 13,
}

// ─────────────────────────────────────────────────────────────────────────────
// Events — emitted for off-chain keeper bots to consume
// ─────────────────────────────────────────────────────────────────────────────

pub fn emit_task_registered(e: &Env, task_id: u64, owner: &Address, reward: i128, deadline: u64) {
    e.events().publish(
        (symbol_short!("reg"), symbol_short!("task")),
        (task_id, owner.clone(), reward, deadline),
    );
}

pub fn emit_task_claimed(e: &Env, task_id: u64, keeper: &Address) {
    e.events().publish(
        (symbol_short!("claim"), symbol_short!("task")),
        (task_id, keeper.clone(), e.ledger().sequence()),
    );
}

pub fn emit_task_executed(e: &Env, task_id: u64, keeper: &Address, net_reward: i128) {
    e.events().publish(
        (symbol_short!("exec"), symbol_short!("task")),
        (task_id, keeper.clone(), net_reward),
    );
}

pub fn emit_task_expired(e: &Env, task_id: u64) {
    e.events().publish(
        (symbol_short!("exp"), symbol_short!("task")),
        (task_id,),
    );
}

pub fn emit_task_cancelled(e: &Env, task_id: u64, owner: &Address) {
    e.events().publish(
        (symbol_short!("cancel"), symbol_short!("task")),
        (task_id, owner.clone()),
    );
}

pub fn emit_rewards_withdrawn(e: &Env, keeper: &Address, amount: i128) {
    e.events().publish(
        (symbol_short!("wdraw"), symbol_short!("reward")),
        (keeper.clone(), amount),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn require_not_paused(e: &Env) -> Result<(), KeeperError> {
    if e.storage().instance().get(&DataKey::Paused).unwrap_or(false) {
        Err(KeeperError::ContractPaused)
    } else {
        Ok(())
    }
}

fn require_admin(e: &Env, caller: &Address) -> Result<(), KeeperError> {
    let admin: Address = e
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(KeeperError::Unauthorized)?;
    caller.require_auth();
    if *caller != admin {
        return Err(KeeperError::Unauthorized);
    }
    Ok(())
}

fn next_task_id(e: &Env) -> u64 {
    let id: u64 = e.storage().instance().get(&DataKey::TaskCounter).unwrap_or(0u64);
    let next = id.checked_add(1).expect("task id overflow");
    e.storage().instance().set(&DataKey::TaskCounter, &next);
    next
}

fn load_task(e: &Env, task_id: u64) -> Result<Task, KeeperError> {
    e.storage()
        .persistent()
        .get(&DataKey::Task(task_id))
        .ok_or(KeeperError::TaskNotFound)
}

fn save_task(e: &Env, task_id: u64, task: &Task) {
    e.storage().persistent().set(&DataKey::Task(task_id), task);
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Task(task_id), task.ttl_ledgers, task.ttl_ledgers);
}

fn reward_token(e: &Env) -> token::Client {
    let addr: Address = e
        .storage()
        .instance()
        .get(&DataKey::RewardToken)
        .expect("not initialized");
    token::Client::new(e, &addr)
}

/// Returns (keeper_net, protocol_fee).
fn split_reward(reward: i128, fee_bps: u32) -> (i128, i128) {
    let fee = reward
        .checked_mul(fee_bps as i128).expect("overflow")
        .checked_div(10_000).expect("div zero");
    (reward.checked_sub(fee).expect("underflow"), fee)
}

/// Adds `amount` to a keeper's withdrawable balance in Persistent storage.
/// Shared by `execute_task` (credit) and used as the source of truth for
/// `withdraw_rewards`. Kept as a single helper so the CEI invariant lives in
/// one place.
fn credit_keeper(e: &Env, keeper: &Address, amount: i128) {
    let key = DataKey::KeeperReward(keeper.clone());
    let current: i128 = e.storage().persistent().get(&key).unwrap_or(0);
    let updated = current.checked_add(amount).expect("keeper balance overflow");
    e.storage().persistent().set(&key, &updated);
    e.storage().persistent().extend_ttl(&key, 100_000, 100_000);
}

/// True once a claimed task's exclusive lock window has elapsed, meaning any
/// keeper may re-claim it. This is what prevents a keeper from claiming and then
/// never executing: after `lock_ledgers`, the task is fair game again.
fn lock_expired(e: &Env, task: &Task) -> bool {
    match task.claim_ledger {
        Some(claimed_at) => {
            let unlock_at = claimed_at.saturating_add(task.lock_ledgers);
            e.ledger().sequence() >= unlock_at
        }
        None => true,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct KeeperRegistry;

#[contractimpl]
impl KeeperRegistry {

    // ── initialize ───────────────────────────────────────────────────────────
    //
    // Fully implemented. Call once after deployment.
    //
    // Arguments:
    //   admin        — address that controls admin functions
    //   reward_token — SAC / XLM token contract address used for escrow
    //   fee_bps      — platform fee in basis points (e.g. 300 = 3%)

    pub fn initialize(
        e: Env,
        admin: Address,
        reward_token: Address,
        fee_bps: u32,
    ) -> Result<(), KeeperError> {
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(KeeperError::AlreadyInitialized);
        }
        if fee_bps > 10_000 {
            return Err(KeeperError::InvalidFeeBps);
        }
        admin.require_auth();

        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::RewardToken, &reward_token);
        e.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        e.storage().instance().set(&DataKey::Paused, &false);
        e.storage().instance().set(&DataKey::TaskCounter, &0u64);
        e.storage().instance().extend_ttl(100_000, 100_000);

        log!(&e, "KeeperRegistry initialized by {}", admin);
        Ok(())
    }

    // ── register_task ────────────────────────────────────────────────────────
    //
    // Fully implemented. Any dApp or wallet calls this to post a task.
    // The reward is escrowed in this contract immediately on registration.
    //
    // Arguments:
    //   owner        — address funding the task (must auth)
    //   task_type    — classification (Liquidation, OraclePricePush, …)
    //   calldata     — encoded params the keeper uses to build the target call
    //   reward       — XLM stroops escrowed as bounty
    //   deadline     — unix timestamp after which the task expires
    //   ttl_ledgers  — how long to keep the storage entry alive
    //   lock_ledgers — ledgers the claimer holds exclusive rights
    //
    // Returns the new task_id.

    pub fn register_task(
        e: Env,
        owner: Address,
        task_type: TaskType,
        calldata: Bytes,
        reward: i128,
        deadline: u64,
        ttl_ledgers: u32,
        lock_ledgers: u32,
    ) -> Result<u64, KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        if reward <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        if deadline <= e.ledger().timestamp() {
            return Err(KeeperError::DeadlinePassed);
        }

        // Escrow the reward from the owner into this contract.
        reward_token(&e).transfer(&owner, &e.current_contract_address(), &reward);

        let task_id = next_task_id(&e);
        let task = Task {
            owner: owner.clone(),
            task_type,
            calldata,
            reward,
            deadline,
            ttl_ledgers,
            status: TaskStatus::Pending,
            claimer: None,
            claim_ledger: None,
            lock_ledgers,
        };
        save_task(&e, task_id, &task);
        emit_task_registered(&e, task_id, &owner, reward, deadline);

        log!(&e, "Task {} registered reward={}", task_id, reward);
        Ok(task_id)
    }

    // ── claim_task ───────────────────────────────────────────────────────────
    //
    // Permissionless first-come-first-served claiming. A Pending task may be
    // claimed by anyone; a Claimed task may be re-claimed only after its
    // previous claimer's lock window has elapsed (see `lock_expired`), which
    // stops a keeper from squatting on a task it never intends to execute.

    pub fn claim_task(e: Env, keeper: Address, task_id: u64) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        let mut task = load_task(&e, task_id)?;

        if e.ledger().timestamp() >= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        match task.status {
            TaskStatus::Pending => {}
            TaskStatus::Claimed => {
                // Only allow a takeover once the current lock has expired.
                if !lock_expired(&e, &task) {
                    return Err(KeeperError::LockPeriodActive);
                }
            }
            _ => return Err(KeeperError::InvalidTaskStatus),
        }

        task.status = TaskStatus::Claimed;
        task.claimer = Some(keeper.clone());
        task.claim_ledger = Some(e.ledger().sequence());
        save_task(&e, task_id, &task);

        emit_task_claimed(&e, task_id, &keeper);
        log!(&e, "Task {} claimed by {}", task_id, keeper);
        Ok(())
    }

    // ── execute_task ─────────────────────────────────────────────────────────
    //
    // TODO(contributors): implement execution proof submission + reward payout.
    //
    // Rules to enforce:
    //   - caller must be the task.claimer
    //   - task must be in Claimed status
    //   - deadline must not have passed
    //   - split reward: credit net to keeper via credit_keeper(), fee stays in contract
    //   - set task.status = Executed
    //   - emit emit_task_executed(...)
    //
    // Helpful internal fns: split_reward(), save_task(), reward_token()
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/2

    pub fn execute_task(
        _e: Env,
        _keeper: Address,
        _task_id: u64,
        _proof: Bytes,
    ) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #2")
    }

    // ── cancel_task ──────────────────────────────────────────────────────────
    //
    // TODO(contributors): let a task owner cancel a Pending task and get refunded.
    //
    // Rules to enforce:
    //   - caller must be task.owner
    //   - task must be in Pending status (cannot cancel once claimed)
    //   - transfer task.reward back to owner
    //   - set task.status = Cancelled
    //   - emit emit_task_cancelled(...)
    //
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/3

    pub fn cancel_task(_e: Env, _owner: Address, _task_id: u64) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #3")
    }

    // ── expire_task ──────────────────────────────────────────────────────────
    //
    // TODO(contributors): permissionless expiry — anyone calls this after deadline.
    //
    // Rules to enforce:
    //   - task must be Pending or Claimed
    //   - ledger.timestamp() must be >= task.deadline
    //   - return task.reward to task.owner
    //   - set task.status = Expired
    //   - emit emit_task_expired(...)
    //
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/4

    pub fn expire_task(_e: Env, _task_id: u64) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #4")
    }

    // ── withdraw_rewards ─────────────────────────────────────────────────────
    //
    // TODO(contributors): keepers call this to pull their accumulated balance.
    //
    // Rules to enforce:
    //   - balance must be > 0 (return NoRewardsAvailable otherwise)
    //   - zero the balance BEFORE transferring (CEI pattern — prevents re-entrancy)
    //   - transfer balance to keeper
    //   - emit emit_rewards_withdrawn(...)
    //   - return the withdrawn amount
    //
    // Hint: the keeper's balance is stored at DataKey::KeeperReward(address).
    //       You will need a credit_keeper() helper used by execute_task too.
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/5

    pub fn withdraw_rewards(_e: Env, _keeper: Address) -> Result<i128, KeeperError> {
        panic!("not yet implemented — see GitHub issue #5")
    }

    // ── pause / unpause ───────────────────────────────────────────────────────
    //
    // TODO(contributors): admin emergency circuit breaker.
    //   - require_admin() then flip DataKey::Paused
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/6

    pub fn pause(_e: Env, _admin: Address) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #6")
    }

    pub fn unpause(_e: Env, _admin: Address) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #6")
    }

    // ── set_fee_bps ───────────────────────────────────────────────────────────
    //
    // TODO(contributors): admin adjusts the platform fee (max 10 000 bps).
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/7

    pub fn set_fee_bps(_e: Env, _admin: Address, _new_bps: u32) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #7")
    }

    // ── transfer_admin ────────────────────────────────────────────────────────
    //
    // TODO(contributors): hand admin role to a new address.
    //   - both current admin AND new_admin must require_auth()
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/8

    pub fn transfer_admin(
        _e: Env,
        _admin: Address,
        _new_admin: Address,
    ) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #8")
    }

    // ── upgrade ───────────────────────────────────────────────────────────────
    //
    // TODO(contributors): upgrade the contract WASM hash (admin only).
    //   - call e.deployer().update_current_contract_wasm(new_wasm_hash)
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/9

    pub fn upgrade(_e: Env, _admin: Address, _new_wasm_hash: BytesN<32>) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #9")
    }

    // ── sweep_fees ────────────────────────────────────────────────────────────
    //
    // TODO(contributors): admin moves accumulated protocol fees to a treasury.
    // Tracking issue: https://github.com/arandomogg/soroban-keeper-network/issues/10

    pub fn sweep_fees(
        _e: Env,
        _admin: Address,
        _treasury: Address,
        _amount: i128,
    ) -> Result<(), KeeperError> {
        panic!("not yet implemented — see GitHub issue #10")
    }

    // ── Read-only views ───────────────────────────────────────────────────────

    pub fn get_task(e: Env, task_id: u64) -> Result<Task, KeeperError> {
        load_task(&e, task_id)
    }

    pub fn task_count(e: Env) -> u64 {
        e.storage().instance().get(&DataKey::TaskCounter).unwrap_or(0u64)
    }

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
        e.storage().instance().get(&DataKey::FeeBps).unwrap_or(300u32)
    }

    pub fn is_paused(e: Env) -> bool {
        e.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn reward_token_address(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::RewardToken)
    }
}

#[cfg(test)]
mod test;
