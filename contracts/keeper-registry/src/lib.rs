//! # Soroban Keeper Network — Keeper Registry Contract
//!
//! This is the on-chain coordination layer of the Soroban Keeper Network.
//! dApps register automation tasks (liquidations, oracle pushes, TTL extensions…)
//! with an XLM reward bounty. Permissionless keeper bots compete to execute them.
//!
//! ## Implemented surface (MVP complete)
//! - Full schema: storage keys, types, errors, and events
//! - `initialize` / `register_task` — deploy, configure, and post funded tasks
//! - `claim_task` — first-come-first-served keeper locking with re-claim after
//!   the lock window elapses
//! - `execute_task` — proof submission, reward split, keeper crediting
//! - `cancel_task` / `expire_task` — owner refund and permissionless expiry
//! - `withdraw_rewards` — keeper pulls its accrued balance (CEI-safe)
//! - Admin: `pause`/`unpause`, `set_fee_bps`, `transfer_admin`, `upgrade`,
//!   `sweep_fees`
//! - Read-only views — `get_task`, `task_count`, `keeper_balance`,
//!   `fees_accrued`, `is_paused`, etc.
//!
//! ## Where contributors come in
//! The MVP is functional; the open issues now target Phase 2 (see README
//! Roadmap): on-chain execution verifiers, batch registration, keeper
//! staking/reputation, and an events indexer. See CONTRIBUTING.md.
//!
//! ## Storage Layout
//! - Instance:   Admin, FeeBps, Paused, TaskCounter, RewardToken, FeesAccrued
//! - Persistent: Task(id) → Task struct, KeeperReward(address) → i128

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address, Bytes,
    BytesN, Env,
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
    /// Running total of protocol fees withheld from executed tasks, awaiting
    /// `sweep_fees`. Kept separate from task escrow so a sweep can never touch
    /// funds owed to owners or keepers.
    FeesAccrued,
    /// Minimum reward a task may be registered with. Guards against dust-spam
    /// tasks that would cost keepers more in fees than they pay out. Default 0.
    MinReward,
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/// The kind of automation this task represents.
/// Contributors: add new variants here as the network supports more use-cases.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TaskType {
    Liquidation = 0,
    OraclePricePush = 1,
    FundingRateUpdate = 2,
    LiquidityRebalance = 3,
    TtlExtension = 4,
    Custom = 5,
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
    Pending = 0,
    Claimed = 1,
    Executed = 2,
    Cancelled = 3,
    Expired = 4,
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
    Unauthorized = 2,
    ContractPaused = 3,
    TaskNotFound = 4,
    InvalidTaskStatus = 5,
    DeadlinePassed = 6,
    DeadlineNotPassed = 7,
    InvalidReward = 8,
    LockPeriodActive = 9,
    InvalidFeeBps = 10,
    NotTaskOwner = 11,
    NotTaskClaimer = 12,
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
    e.events()
        .publish((symbol_short!("exp"), symbol_short!("task")), (task_id,));
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

pub fn emit_paused(e: &Env, paused: bool) {
    e.events()
        .publish((symbol_short!("paused"), symbol_short!("admin")), (paused,));
}

pub fn emit_fee_updated(e: &Env, old_bps: u32, new_bps: u32) {
    e.events().publish(
        (symbol_short!("fee"), symbol_short!("admin")),
        (old_bps, new_bps),
    );
}

pub fn emit_admin_transferred(e: &Env, old_admin: &Address, new_admin: &Address) {
    e.events().publish(
        (symbol_short!("admin"), symbol_short!("xfer")),
        (old_admin.clone(), new_admin.clone()),
    );
}

pub fn emit_reward_increased(e: &Env, task_id: u64, new_reward: i128) {
    e.events().publish(
        (symbol_short!("topup"), symbol_short!("task")),
        (task_id, new_reward),
    );
}

pub fn emit_deadline_extended(e: &Env, task_id: u64, new_deadline: u64) {
    e.events().publish(
        (symbol_short!("extend"), symbol_short!("task")),
        (task_id, new_deadline),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn require_not_paused(e: &Env) -> Result<(), KeeperError> {
    if e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
    {
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
    let id: u64 = e
        .storage()
        .instance()
        .get(&DataKey::TaskCounter)
        .unwrap_or(0u64);
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
    e.storage().persistent().extend_ttl(
        &DataKey::Task(task_id),
        task.ttl_ledgers,
        task.ttl_ledgers,
    );
}

fn reward_token(e: &Env) -> token::Client<'_> {
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
        .checked_mul(fee_bps as i128)
        .expect("overflow")
        .checked_div(10_000)
        .expect("div zero");
    (reward.checked_sub(fee).expect("underflow"), fee)
}

/// Adds `amount` to a keeper's withdrawable balance in Persistent storage.
/// Shared by `execute_task` (credit) and used as the source of truth for
/// `withdraw_rewards`. Kept as a single helper so the CEI invariant lives in
/// one place.
fn credit_keeper(e: &Env, keeper: &Address, amount: i128) {
    let key = DataKey::KeeperReward(keeper.clone());
    let current: i128 = e.storage().persistent().get(&key).unwrap_or(0);
    let updated = current
        .checked_add(amount)
        .expect("keeper balance overflow");
    e.storage().persistent().set(&key, &updated);
    e.storage().persistent().extend_ttl(&key, 100_000, 100_000);
}

/// Adds `amount` to the swept-able protocol fee accumulator (instance storage).
fn accrue_fee(e: &Env, amount: i128) {
    if amount == 0 {
        return;
    }
    let current: i128 = e
        .storage()
        .instance()
        .get(&DataKey::FeesAccrued)
        .unwrap_or(0);
    let updated = current
        .checked_add(amount)
        .expect("fee accumulator overflow");
    e.storage().instance().set(&DataKey::FeesAccrued, &updated);
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

/// Semantic version of the contract logic. Bumped on behavior changes so
/// off-chain clients and indexers can detect which ABI they are talking to.
pub const VERSION: u32 = 1;

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
        e.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
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

    // The task parameters are all distinct scalars a caller must supply; a
    // params struct would just move them without improving the ABI.
    #[allow(clippy::too_many_arguments)]
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
        let min_reward: i128 = e.storage().instance().get(&DataKey::MinReward).unwrap_or(0);
        if reward < min_reward {
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

    // ── increase_reward ──────────────────────────────────────────────────────
    //
    // The owner tops up the bounty on a task that hasn't finished yet (Pending
    // or Claimed) to attract keepers. The extra amount is escrowed immediately.

    pub fn increase_reward(
        e: Env,
        owner: Address,
        task_id: u64,
        additional: i128,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        owner.require_auth();

        if additional <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        match task.status {
            TaskStatus::Pending | TaskStatus::Claimed => {}
            _ => return Err(KeeperError::InvalidTaskStatus),
        }

        reward_token(&e).transfer(&owner, &e.current_contract_address(), &additional);
        task.reward = task
            .reward
            .checked_add(additional)
            .expect("reward overflow");
        save_task(&e, task_id, &task);

        emit_reward_increased(&e, task_id, task.reward);
        log!(&e, "Task {} reward increased to {}", task_id, task.reward);
        Ok(())
    }

    // ── extend_deadline ──────────────────────────────────────────────────────
    //
    // The owner pushes out the deadline on an unfinished task so keepers have
    // more time. The new deadline must be strictly later than the current one.

    pub fn extend_deadline(
        e: Env,
        owner: Address,
        task_id: u64,
        new_deadline: u64,
    ) -> Result<(), KeeperError> {
        owner.require_auth();

        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        match task.status {
            TaskStatus::Pending | TaskStatus::Claimed => {}
            _ => return Err(KeeperError::InvalidTaskStatus),
        }
        if new_deadline <= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        task.deadline = new_deadline;
        save_task(&e, task_id, &task);

        emit_deadline_extended(&e, task_id, new_deadline);
        log!(&e, "Task {} deadline extended to {}", task_id, new_deadline);
        Ok(())
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
    // The claiming keeper submits proof that it performed the off-chain action
    // and is credited its share of the escrowed reward. The protocol fee stays
    // in the contract (later swept by admin via `sweep_fees`). The reward is
    // credited to an internal balance rather than transferred out here so the
    // keeper controls when it pays the withdrawal transfer cost.

    pub fn execute_task(
        e: Env,
        keeper: Address,
        task_id: u64,
        proof: Bytes,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        let mut task = load_task(&e, task_id)?;

        if task.status != TaskStatus::Claimed {
            return Err(KeeperError::InvalidTaskStatus);
        }
        // Only the keeper that currently holds the claim may execute.
        if task.claimer.as_ref() != Some(&keeper) {
            return Err(KeeperError::NotTaskClaimer);
        }
        if e.ledger().timestamp() >= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        let fee_bps: u32 = e.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let (keeper_net, fee) = split_reward(task.reward, fee_bps);
        credit_keeper(&e, &keeper, keeper_net);
        accrue_fee(&e, fee);

        task.status = TaskStatus::Executed;
        save_task(&e, task_id, &task);

        emit_task_executed(&e, task_id, &keeper, keeper_net);
        log!(
            &e,
            "Task {} executed by {} net={} proof_len={}",
            task_id,
            keeper,
            keeper_net,
            proof.len()
        );
        Ok(())
    }

    // ── cancel_task ──────────────────────────────────────────────────────────
    //
    // The owner reclaims a task that no keeper has picked up yet. Only Pending
    // tasks can be cancelled — once a keeper has claimed one, the owner must
    // wait for execution or for the deadline to pass (expire_task), so a keeper
    // that has started work can't have the reward pulled out from under it.

    pub fn cancel_task(e: Env, owner: Address, task_id: u64) -> Result<(), KeeperError> {
        owner.require_auth();

        let mut task = load_task(&e, task_id)?;
        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        if task.status != TaskStatus::Pending {
            return Err(KeeperError::InvalidTaskStatus);
        }

        // Refund the escrow, then mark cancelled (CEI: state after transfer is
        // safe here because status guards prevent re-entry into a fresh cancel).
        reward_token(&e).transfer(&e.current_contract_address(), &owner, &task.reward);
        task.status = TaskStatus::Cancelled;
        save_task(&e, task_id, &task);

        emit_task_cancelled(&e, task_id, &owner);
        log!(
            &e,
            "Task {} cancelled, {} refunded to {}",
            task_id,
            task.reward,
            owner
        );
        Ok(())
    }

    // ── expire_task ──────────────────────────────────────────────────────────
    //
    // Permissionless deadline enforcement: once a task's deadline has passed
    // without execution, anyone may call this to return the escrow to the owner.
    // It is intentionally callable by any address (not just the owner) so a
    // stuck task can always be unwound and its funds recovered — a keeper bot
    // can even do this as a courtesy while scanning.

    pub fn expire_task(e: Env, task_id: u64) -> Result<(), KeeperError> {
        let mut task = load_task(&e, task_id)?;

        match task.status {
            TaskStatus::Pending | TaskStatus::Claimed => {}
            _ => return Err(KeeperError::InvalidTaskStatus),
        }
        if e.ledger().timestamp() < task.deadline {
            return Err(KeeperError::DeadlineNotPassed);
        }

        reward_token(&e).transfer(&e.current_contract_address(), &task.owner, &task.reward);
        task.status = TaskStatus::Expired;
        save_task(&e, task_id, &task);

        emit_task_expired(&e, task_id);
        log!(
            &e,
            "Task {} expired, {} refunded to owner",
            task_id,
            task.reward
        );
        Ok(())
    }

    // ── withdraw_rewards ─────────────────────────────────────────────────────
    //
    // A keeper pulls its accumulated balance. Follows checks-effects-
    // interactions: the stored balance is zeroed BEFORE the token transfer, so
    // even a malicious reward token that re-enters cannot double-spend the
    // balance. Returns the amount withdrawn.

    pub fn withdraw_rewards(e: Env, keeper: Address) -> Result<i128, KeeperError> {
        keeper.require_auth();

        let key = DataKey::KeeperReward(keeper.clone());
        let balance: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if balance <= 0 {
            return Err(KeeperError::NoRewardsAvailable);
        }

        // Effects before interaction.
        e.storage().persistent().set(&key, &0i128);
        reward_token(&e).transfer(&e.current_contract_address(), &keeper, &balance);

        emit_rewards_withdrawn(&e, &keeper, balance);
        log!(&e, "Keeper {} withdrew {}", keeper, balance);
        Ok(balance)
    }

    // ── pause / unpause ───────────────────────────────────────────────────────
    //
    // Admin emergency circuit breaker. While paused, register_task/claim_task/
    // execute_task are blocked, but expire_task and withdraw_rewards remain open
    // so funds can always be recovered even during an incident.

    pub fn pause(e: Env, admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        e.storage().instance().set(&DataKey::Paused, &true);
        emit_paused(&e, true);
        log!(&e, "Registry paused by {}", admin);
        Ok(())
    }

    pub fn unpause(e: Env, admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        e.storage().instance().set(&DataKey::Paused, &false);
        emit_paused(&e, false);
        log!(&e, "Registry unpaused by {}", admin);
        Ok(())
    }

    // ── set_fee_bps ───────────────────────────────────────────────────────────
    //
    // Admin adjusts the platform fee. The new rate only affects tasks executed
    // after this call; already-accrued fees are unaffected.

    pub fn set_fee_bps(e: Env, admin: Address, new_bps: u32) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if new_bps > 10_000 {
            return Err(KeeperError::InvalidFeeBps);
        }
        let old_bps: u32 = e.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        e.storage().instance().set(&DataKey::FeeBps, &new_bps);
        emit_fee_updated(&e, old_bps, new_bps);
        log!(&e, "Fee updated to {} bps", new_bps);
        Ok(())
    }

    // ── set_min_reward ────────────────────────────────────────────────────────
    //
    // Admin sets the minimum reward a task may be registered with. Existing
    // tasks are unaffected; only future registrations are validated.

    pub fn set_min_reward(e: Env, admin: Address, min_reward: i128) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if min_reward < 0 {
            return Err(KeeperError::InvalidReward);
        }
        e.storage().instance().set(&DataKey::MinReward, &min_reward);
        log!(&e, "Min reward set to {}", min_reward);
        Ok(())
    }

    // ── transfer_admin ────────────────────────────────────────────────────────
    //
    // Hands the admin role to a new address. Both the current admin and the
    // incoming admin must authorize, so the role can never be transferred to an
    // address that has not consented to take it (no accidental lock-out).

    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        new_admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        emit_admin_transferred(&e, &admin, &new_admin);
        log!(&e, "Admin transferred from {} to {}", admin, new_admin);
        Ok(())
    }

    // ── upgrade ───────────────────────────────────────────────────────────────
    //
    // Admin swaps the contract WASM for a new hash (already installed on-chain).
    // Storage layout is preserved across the upgrade.

    pub fn upgrade(e: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        e.deployer().update_current_contract_wasm(new_wasm_hash);
        log!(&e, "Contract upgraded by {}", admin);
        Ok(())
    }

    // ── sweep_fees ────────────────────────────────────────────────────────────
    //
    // Admin moves up to the accrued protocol fees to a treasury address. The
    // amount is checked against the FeesAccrued accumulator, so a sweep can
    // never dip into task escrow or keeper balances.

    pub fn sweep_fees(
        e: Env,
        admin: Address,
        treasury: Address,
        amount: i128,
    ) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;

        if amount <= 0 {
            return Err(KeeperError::InvalidReward);
        }
        let accrued: i128 = e
            .storage()
            .instance()
            .get(&DataKey::FeesAccrued)
            .unwrap_or(0);
        if amount > accrued {
            return Err(KeeperError::NoRewardsAvailable);
        }

        // Effects before interaction.
        e.storage()
            .instance()
            .set(&DataKey::FeesAccrued, &(accrued - amount));
        reward_token(&e).transfer(&e.current_contract_address(), &treasury, &amount);

        log!(&e, "Swept {} fees to {}", amount, treasury);
        Ok(())
    }

    /// Read-only: protocol fees accrued and awaiting sweep.
    pub fn fees_accrued(e: Env) -> i128 {
        e.storage()
            .instance()
            .get(&DataKey::FeesAccrued)
            .unwrap_or(0)
    }

    // ── Read-only views ───────────────────────────────────────────────────────

    pub fn get_task(e: Env, task_id: u64) -> Result<Task, KeeperError> {
        load_task(&e, task_id)
    }

    pub fn task_count(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&DataKey::TaskCounter)
            .unwrap_or(0u64)
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
        e.storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(300u32)
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
        e.storage().instance().get(&DataKey::MinReward).unwrap_or(0)
    }

    /// Contract logic version. See [`VERSION`].
    pub fn version(_e: Env) -> u32 {
        VERSION
    }
}

#[cfg(test)]
mod test;
