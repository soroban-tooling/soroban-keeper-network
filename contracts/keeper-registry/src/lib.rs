//! # Soroban Keeper Network — Keeper Registry Contract
//!
//! The KeeperRegistry is the on-chain coordination layer of the Soroban Keeper Network.
//! It allows dApps to register recurring or time-sensitive automation tasks, and allows
//! permissionless keepers (bots) to claim and execute those tasks in exchange for XLM rewards.
//!
//! ## Design Principles
//! - **Permissionless**: Anyone can run a keeper and earn rewards.
//! - **Composable**: Any Soroban contract can register tasks via cross-contract calls.
//! - **Gas-efficient**: Uses Persistent/Temporary/Instance storage appropriately.
//! - **Secure**: Leverages Soroban's native auth framework; no re-entrancy vectors.
//! - **Upgradeable**: Admin can upgrade the WASM via Stellar's upgrade pattern.
//!
//! ## Storage Layout
//! - Instance: Admin, FeePercent, Paused, TaskCounter
//! - Persistent: TaskRegistry (task_id → Task), KeeperRewards (keeper → balance)

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    log, symbol_short,
    token,
    Address, Bytes, BytesN, Env, Map, Symbol, Vec,
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage Keys
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance storage: contract admin
    Admin,
    /// Instance storage: platform fee in basis points (e.g. 300 = 3%)
    FeeBps,
    /// Instance storage: pause switch
    Paused,
    /// Instance storage: monotonically increasing task ID counter
    TaskCounter,
    /// Persistent storage: Task data for a given task_id
    Task(u64),
    /// Persistent storage: unclaimed reward balance for a keeper address
    KeeperReward(Address),
    /// Instance storage: XLM/reward token contract address
    RewardToken,
}

// ─────────────────────────────────────────────────────────────────────────────
// Enums & Structs
// ─────────────────────────────────────────────────────────────────────────────

/// Classification of automation task. dApps may also use `Custom`.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TaskType {
    /// DeFi position that has breached health factor and must be liquidated
    Liquidation       = 0,
    /// Push a new price from an off-chain oracle source on-chain
    OraclePricePush   = 1,
    /// Update the funding rate for a perpetuals market
    FundingRateUpdate = 2,
    /// Rebalance LP positions across price ranges
    LiquidityRebalance = 3,
    /// Extend the TTL of a Soroban storage entry to avoid expiry
    TtlExtension      = 4,
    /// Catch-all for protocol-specific automation
    Custom            = 5,
}

/// Lifecycle state of a registered task
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TaskStatus {
    /// Registered and awaiting a keeper claim
    Pending   = 0,
    /// Claimed by a keeper; within lock period, awaiting execution proof
    Claimed   = 1,
    /// Successfully executed; reward has been credited to the keeper
    Executed  = 2,
    /// Cancelled by the task owner before execution
    Cancelled = 3,
    /// Passed deadline without execution; reward returned to owner
    Expired   = 4,
}

/// Full task record stored on-chain
#[contracttype]
#[derive(Clone, Debug)]
pub struct Task {
    /// Address that registered and funded this task
    pub owner: Address,
    /// What kind of automation this task represents
    pub task_type: TaskType,
    /// Arbitrary ABI-encoded call arguments that the off-chain keeper uses
    /// to construct the target invocation (not executed on-chain by this contract)
    pub calldata: Bytes,
    /// XLM stroops (or token units) deposited as keeper reward
    pub reward: i128,
    /// Unix timestamp (seconds) after which the task is considered expired
    pub deadline: u64,
    /// Soroban ledger TTL (in ledgers) for how long this task entry persists
    pub ttl_ledgers: u32,
    /// Current lifecycle state
    pub status: TaskStatus,
    /// Keeper who claimed this task (None if still Pending)
    pub claimer: Option<Address>,
    /// Ledger number at which the task was claimed (used to enforce lock period)
    pub claim_ledger: Option<u32>,
    /// Number of ledgers a keeper must wait after claiming before others can re-claim
    /// (prevents claim-griefing while giving the claimer time to execute)
    pub lock_ledgers: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum KeeperError {
    /// Contract has already been initialized
    AlreadyInitialized   = 1,
    /// Caller is not the contract admin
    Unauthorized         = 2,
    /// Contract is administratively paused
    ContractPaused       = 3,
    /// The referenced task does not exist
    TaskNotFound         = 4,
    /// Action is not valid for the task's current status
    InvalidTaskStatus    = 5,
    /// Task deadline has already passed
    DeadlinePassed       = 6,
    /// Task deadline is not yet in the past (cannot expire early)
    DeadlineNotPassed    = 7,
    /// Reward amount must be positive
    InvalidReward        = 8,
    /// Lock period is still active; cannot re-claim or expire yet
    LockPeriodActive     = 9,
    /// Fee basis points must be 0–10000
    InvalidFeeBps        = 10,
    /// Caller is not the task owner
    NotTaskOwner         = 11,
    /// Caller is not the claimer of this task
    NotTaskClaimer       = 12,
    /// No rewards available to withdraw
    NoRewardsAvailable   = 13,
    /// Arithmetic overflow/underflow
    MathOverflow         = 14,
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/// Emitted when a new task is registered
fn emit_task_registered(e: &Env, task_id: u64, owner: &Address, reward: i128, deadline: u64) {
    e.events().publish(
        (symbol_short!("reg"), symbol_short!("task")),
        (task_id, owner.clone(), reward, deadline),
    );
}

/// Emitted when a keeper claims a task
fn emit_task_claimed(e: &Env, task_id: u64, keeper: &Address) {
    e.events().publish(
        (symbol_short!("claim"), symbol_short!("task")),
        (task_id, keeper.clone(), e.ledger().sequence()),
    );
}

/// Emitted when a task is marked executed and reward is credited
fn emit_task_executed(e: &Env, task_id: u64, keeper: &Address, net_reward: i128) {
    e.events().publish(
        (symbol_short!("exec"), symbol_short!("task")),
        (task_id, keeper.clone(), net_reward),
    );
}

/// Emitted when a task's deadline passes and it is expired
fn emit_task_expired(e: &Env, task_id: u64) {
    e.events().publish(
        (symbol_short!("exp"), symbol_short!("task")),
        (task_id,),
    );
}

/// Emitted when a task owner cancels their task
fn emit_task_cancelled(e: &Env, task_id: u64, owner: &Address) {
    e.events().publish(
        (symbol_short!("cancel"), symbol_short!("task")),
        (task_id, owner.clone()),
    );
}

/// Emitted when a keeper withdraws accumulated rewards
fn emit_rewards_withdrawn(e: &Env, keeper: &Address, amount: i128) {
    e.events().publish(
        (symbol_short!("withdraw"), symbol_short!("reward")),
        (keeper.clone(), amount),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn require_not_paused(e: &Env) -> Result<(), KeeperError> {
    let paused: bool = e
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
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
    e.storage()
        .instance()
        .set(&DataKey::TaskCounter, &next);
    next
}

fn get_task(e: &Env, task_id: u64) -> Result<Task, KeeperError> {
    e.storage()
        .persistent()
        .get(&DataKey::Task(task_id))
        .ok_or(KeeperError::TaskNotFound)
}

fn save_task(e: &Env, task_id: u64, task: &Task) {
    e.storage()
        .persistent()
        .set(&DataKey::Task(task_id), task);
    // Extend TTL so the task record persists for at least task.ttl_ledgers more ledgers
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Task(task_id), task.ttl_ledgers, task.ttl_ledgers);
}

fn credit_keeper(e: &Env, keeper: &Address, amount: i128) {
    let current: i128 = e
        .storage()
        .persistent()
        .get(&DataKey::KeeperReward(keeper.clone()))
        .unwrap_or(0i128);
    let new_balance = current.checked_add(amount).expect("reward overflow");
    e.storage()
        .persistent()
        .set(&DataKey::KeeperReward(keeper.clone()), &new_balance);
    // Keep reward entry alive for a reasonable window (1 year ≈ 6_307_200 ledgers at 5s)
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::KeeperReward(keeper.clone()), 6_307_200, 6_307_200);
}

fn fee_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::FeeBps)
        .unwrap_or(300u32) // default 3%
}

/// Returns (keeper_net, protocol_fee)
fn split_reward(reward: i128, bps: u32) -> (i128, i128) {
    let fee = reward
        .checked_mul(bps as i128)
        .expect("overflow")
        .checked_div(10_000)
        .expect("div zero");
    let net = reward.checked_sub(fee).expect("underflow");
    (net, fee)
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct KeeperRegistry;

#[contractimpl]
impl KeeperRegistry {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Initialize the registry. Must be called exactly once after deployment.
    ///
    /// # Arguments
    /// * `admin`        – Address that can pause, upgrade, and adjust fee
    /// * `reward_token` – XLM contract address (or SAC-wrapped token) used for rewards
    /// * `fee_bps`      – Platform fee in basis points (e.g. 300 = 3%). Max 10 000.
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

        // Keep instance storage alive for a long window
        e.storage().instance().extend_ttl(100_000, 100_000);

        log!(&e, "KeeperRegistry initialized by {}", admin);
        Ok(())
    }

    // ── Task Registration ────────────────────────────────────────────────────

    /// Register a new automation task and escrow the reward.
    ///
    /// The caller must have pre-approved this contract to transfer `reward` token
    /// units from their account (standard SAC `approve` → `transfer_from` pattern).
    ///
    /// # Arguments
    /// * `owner`        – Address registering (and funding) the task
    /// * `task_type`    – Classification of the automation
    /// * `calldata`     – Encoded arguments for the keeper's off-chain invocation
    /// * `reward`       – Amount of reward token escrowed (in token units / stroops)
    /// * `deadline`     – Unix timestamp (seconds) after which the task expires
    /// * `ttl_ledgers`  – Ledger lifetime for the persistent task storage entry
    /// * `lock_ledgers` – How many ledgers a claimer holds exclusive rights before
    ///                    another keeper may re-claim
    ///
    /// # Returns
    /// The unique `task_id` assigned to this task.
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
        let now = e.ledger().timestamp();
        if deadline <= now {
            return Err(KeeperError::DeadlinePassed);
        }

        // Escrow the reward from the task owner into this contract
        let token_addr: Address = e
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("not initialized");
        let token = token::Client::new(&e, &token_addr);
        token.transfer(&owner, &e.current_contract_address(), &reward);

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

        log!(&e, "Task {} registered by {} with reward {}", task_id, owner, reward);
        Ok(task_id)
    }

    // ── Task Claiming ────────────────────────────────────────────────────────

    /// Permissionless: any keeper may claim a Pending task (or re-claim an
    /// expired lock) to signal intent to execute it.
    ///
    /// Claiming is first-come-first-served. If a previous claimer fails to
    /// execute within `lock_ledgers`, a new keeper may call `claim_task` again.
    ///
    /// # Arguments
    /// * `keeper`  – The keeper's address (must auth)
    /// * `task_id` – ID of the task to claim
    pub fn claim_task(e: Env, keeper: Address, task_id: u64) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        let mut task = get_task(&e, task_id)?;
        let now_ts = e.ledger().timestamp();
        let now_ledger = e.ledger().sequence();

        // Task must be claimable
        match task.status {
            TaskStatus::Pending => {}
            TaskStatus::Claimed => {
                // Allow re-claim only after lock period has elapsed
                let claimed_at = task.claim_ledger.unwrap_or(0);
                if now_ledger < claimed_at.saturating_add(task.lock_ledgers) {
                    return Err(KeeperError::LockPeriodActive);
                }
                // Lock expired — allow new claimer
            }
            _ => return Err(KeeperError::InvalidTaskStatus),
        }

        if now_ts >= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        task.status = TaskStatus::Claimed;
        task.claimer = Some(keeper.clone());
        task.claim_ledger = Some(now_ledger);
        save_task(&e, task_id, &task);

        emit_task_claimed(&e, task_id, &keeper);
        log!(&e, "Task {} claimed by keeper {}", task_id, keeper);
        Ok(())
    }

    // ── Task Execution ───────────────────────────────────────────────────────

    /// Mark a claimed task as executed and credit the keeper's reward.
    ///
    /// **Important**: This contract does NOT verify on-chain that the keeper's
    /// action (e.g. liquidation) succeeded — that responsibility belongs to the
    /// target protocol. The keeper provides an execution proof (e.g. a tx hash
    /// or state witness) that is stored in the event for transparency.
    /// Phase 2 will add an optional on-chain verifier interface.
    ///
    /// # Arguments
    /// * `keeper`  – Must be the address that claimed this task
    /// * `task_id` – ID of the task
    /// * `proof`   – Arbitrary bytes representing the execution proof (tx hash, etc.)
    pub fn execute_task(
        e: Env,
        keeper: Address,
        task_id: u64,
        proof: Bytes,
    ) -> Result<(), KeeperError> {
        require_not_paused(&e)?;
        keeper.require_auth();

        let mut task = get_task(&e, task_id)?;

        if task.status != TaskStatus::Claimed {
            return Err(KeeperError::InvalidTaskStatus);
        }
        match &task.claimer {
            Some(c) if *c == keeper => {}
            _ => return Err(KeeperError::NotTaskClaimer),
        }

        let now_ts = e.ledger().timestamp();
        if now_ts >= task.deadline {
            return Err(KeeperError::DeadlinePassed);
        }

        let bps = fee_bps(&e);
        let (net_reward, _protocol_fee) = split_reward(task.reward, bps);

        // Credit net reward to the keeper's claimable balance
        credit_keeper(&e, &keeper, net_reward);

        // Protocol fee stays in contract (admin can sweep via future governance)
        // In Phase 2 this will be sent to a treasury/staking contract automatically.

        task.status = TaskStatus::Executed;
        save_task(&e, task_id, &task);

        // Emit execution event with proof for off-chain indexers
        e.events().publish(
            (symbol_short!("exec"), symbol_short!("task")),
            (task_id, keeper.clone(), net_reward, proof),
        );

        log!(&e, "Task {} executed by keeper {} net_reward={}", task_id, keeper, net_reward);
        Ok(())
    }

    // ── Task Cancellation ────────────────────────────────────────────────────

    /// Task owner cancels their own Pending task and receives a reward refund.
    /// Tasks in Claimed/Executed status cannot be cancelled (keeper has rights).
    ///
    /// # Arguments
    /// * `owner`   – Must be the task's registered owner
    /// * `task_id` – ID of the task to cancel
    pub fn cancel_task(e: Env, owner: Address, task_id: u64) -> Result<(), KeeperError> {
        owner.require_auth();

        let mut task = get_task(&e, task_id)?;

        if task.owner != owner {
            return Err(KeeperError::NotTaskOwner);
        }
        if task.status != TaskStatus::Pending {
            return Err(KeeperError::InvalidTaskStatus);
        }

        // Refund full reward to owner
        let token_addr: Address = e
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("not initialized");
        let token = token::Client::new(&e, &token_addr);
        token.transfer(&e.current_contract_address(), &owner, &task.reward);

        task.status = TaskStatus::Cancelled;
        save_task(&e, task_id, &task);

        emit_task_cancelled(&e, task_id, &owner);
        log!(&e, "Task {} cancelled by owner {}", task_id, owner);
        Ok(())
    }

    // ── Task Expiry ──────────────────────────────────────────────────────────

    /// Permissionless: anyone may expire a task whose deadline has passed.
    /// The reward is returned to the task owner.
    /// If the task was Claimed and the lock period elapsed without execution,
    /// it is also expirable (penalizing an unresponsive keeper — no reward).
    ///
    /// # Arguments
    /// * `task_id` – ID of the task to expire
    pub fn expire_task(e: Env, task_id: u64) -> Result<(), KeeperError> {
        let mut task = get_task(&e, task_id)?;

        if task.status != TaskStatus::Pending && task.status != TaskStatus::Claimed {
            return Err(KeeperError::InvalidTaskStatus);
        }

        let now_ts = e.ledger().timestamp();
        if now_ts < task.deadline {
            return Err(KeeperError::DeadlineNotPassed);
        }

        // Refund full reward to task owner
        let token_addr: Address = e
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("not initialized");
        let token = token::Client::new(&e, &token_addr);
        token.transfer(&e.current_contract_address(), &task.owner, &task.reward);

        task.status = TaskStatus::Expired;
        save_task(&e, task_id, &task);

        emit_task_expired(&e, task_id);
        log!(&e, "Task {} expired; reward returned to owner {}", task_id, task.owner);
        Ok(())
    }

    // ── Reward Withdrawal ────────────────────────────────────────────────────

    /// Keeper withdraws their accumulated net rewards from the contract.
    ///
    /// # Arguments
    /// * `keeper` – The keeper withdrawing their balance
    pub fn withdraw_rewards(e: Env, keeper: Address) -> Result<i128, KeeperError> {
        keeper.require_auth();

        let balance: i128 = e
            .storage()
            .persistent()
            .get(&DataKey::KeeperReward(keeper.clone()))
            .unwrap_or(0i128);

        if balance <= 0 {
            return Err(KeeperError::NoRewardsAvailable);
        }

        // Zero out before transfer (checks-effects-interactions pattern)
        e.storage()
            .persistent()
            .set(&DataKey::KeeperReward(keeper.clone()), &0i128);

        let token_addr: Address = e
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("not initialized");
        let token = token::Client::new(&e, &token_addr);
        token.transfer(&e.current_contract_address(), &keeper, &balance);

        emit_rewards_withdrawn(&e, &keeper, balance);
        log!(&e, "Keeper {} withdrew {} reward tokens", keeper, balance);
        Ok(balance)
    }

    // ── Admin Functions ──────────────────────────────────────────────────────

    /// Pause the contract. Only the admin may call this.
    pub fn pause(e: Env, admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        e.storage().instance().set(&DataKey::Paused, &true);
        log!(&e, "KeeperRegistry paused by {}", admin);
        Ok(())
    }

    /// Unpause the contract. Only the admin may call this.
    pub fn unpause(e: Env, admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        e.storage().instance().set(&DataKey::Paused, &false);
        log!(&e, "KeeperRegistry unpaused by {}", admin);
        Ok(())
    }

    /// Update the platform fee. Only the admin may call this.
    ///
    /// # Arguments
    /// * `admin`   – Admin address (must auth)
    /// * `new_bps` – New fee in basis points (0–10 000)
    pub fn set_fee_bps(e: Env, admin: Address, new_bps: u32) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        if new_bps > 10_000 {
            return Err(KeeperError::InvalidFeeBps);
        }
        e.storage().instance().set(&DataKey::FeeBps, &new_bps);
        log!(&e, "Fee updated to {} bps by {}", new_bps, admin);
        Ok(())
    }

    /// Transfer admin role to a new address.
    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        new_admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        log!(&e, "Admin transferred from {} to {}", admin, new_admin);
        Ok(())
    }

    /// Upgrade the contract WASM. Only the admin may call this.
    /// Uses Soroban's native upgrade mechanism (WASM hash must be already uploaded).
    pub fn upgrade(e: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), KeeperError> {
        require_admin(&e, &admin)?;
        e.deployer().update_current_contract_wasm(new_wasm_hash);
        log!(&e, "Contract upgraded by {}", admin);
        Ok(())
    }

    // ── Sweep Protocol Fees ──────────────────────────────────────────────────

    /// Admin sweeps accumulated protocol fees to a treasury address.
    /// `amount` = 0 sweeps the entire contract token balance minus known keeper rewards.
    /// (In Phase 2 this will be automated via a governance treasury contract.)
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

        let token_addr: Address = e
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("not initialized");
        let token = token::Client::new(&e, &token_addr);
        token.transfer(&e.current_contract_address(), &treasury, &amount);

        log!(&e, "Protocol fee {} swept to treasury {} by admin {}", amount, treasury, admin);
        Ok(())
    }

    // ── Read-only Views ──────────────────────────────────────────────────────

    /// Fetch a task by ID.
    pub fn get_task(e: Env, task_id: u64) -> Result<Task, KeeperError> {
        get_task(&e, task_id)
    }

    /// Returns the total number of tasks ever registered (i.e. the last task_id).
    pub fn task_count(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&DataKey::TaskCounter)
            .unwrap_or(0u64)
    }

    /// Returns the unclaimed reward balance for a keeper address.
    pub fn keeper_balance(e: Env, keeper: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::KeeperReward(keeper))
            .unwrap_or(0i128)
    }

    /// Returns the current admin address.
    pub fn admin(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::Admin)
    }

    /// Returns the current fee in basis points.
    pub fn get_fee_bps(e: Env) -> u32 {
        fee_bps(&e)
    }

    /// Returns true if the contract is paused.
    pub fn is_paused(e: Env) -> bool {
        e.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Returns the reward token contract address.
    pub fn reward_token(e: Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::RewardToken)
    }
}
