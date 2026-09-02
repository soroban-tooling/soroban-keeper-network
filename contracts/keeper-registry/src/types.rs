//! Storage keys and the domain types they hold.

use soroban_sdk::{contracttype, Address, Bytes};

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
/// PENDING ──claim──▶ CLAIMED ──execute+verify(pass)──▶ EXECUTED
///    │                  │ ▲
///  cancel             expire│ execute+verify(reject, retryable)
///    ▼             (deadline│ (returns to CLAIMED for retry)
/// CANCELLED          passed)│
///                       ▼   │
///                    EXPIRED│
///                           └──────────────┘
/// ```
///
/// Note: When a verifier rejects an execution attempt, `execute_task` may
/// return the task to CLAIMED state (retryable failure), distinct from
/// terminal states like CANCELLED or EXPIRED.
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
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Task {
    /// Address that registered and funded this task.
    pub owner: Address,
    pub task_type: TaskType,
    /// Arbitrary bytes the keeper uses to reconstruct the target call
    /// off-chain. Bounded to [`MAX_CALLDATA_LEN`] at registration.
    pub calldata: Bytes,
    /// Reward escrowed in this contract (token units / XLM stroops).
    pub reward: i128,
    /// Unix timestamp (seconds) after which the task may be expired.
    pub deadline: u64,
    /// Ledger TTL for this storage entry.
    pub ttl_ledgers: u32,
    pub verifier: Option<Address>,
    pub status: TaskStatus,

    /// Set when a keeper claims the task.
    pub claimer: Option<Address>,
    /// Ledger sequence at claim time — used to enforce the lock window.
    pub claim_ledger: Option<u32>,
    /// Ledgers the claimer holds exclusive rights before re-claim is allowed.
    pub lock_ledgers: u32,
    /// Optional on-chain proof verifier attached at registration
    /// (`docs/VERIFIER_DESIGN.md`). `None` means `execute_task` trusts the
    /// claimer's proof as before (the wave-1 MVP path, unchanged). `Some(addr)`
    /// means `execute_task` calls `addr`'s `IKeeperVerifier::verify` before
    /// crediting the keeper, rejecting with `KeeperError::VerificationFailed`
    /// if it returns `false` or panics. Any address is permitted — verifiers
    /// are permissionless, like keepers (design doc §5).
    pub verifier: Option<Address>,
}

/// One entry in a [`KeeperRegistry::batch_register_tasks`] call — the same
/// fields `register_task` takes, minus `owner`, which is shared across the
/// whole batch (one auth for the batch, see `docs/BATCH_OPERATIONS.md` §2).
#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchTaskParams {
    pub task_type: TaskType,
    pub calldata: Bytes,
    pub reward: i128,
    pub deadline: u64,
    pub ttl_ledgers: u32,
    pub lock_ledgers: u32,
}
