//! Storage keys and the domain types they hold.

use soroban_sdk::{contracttype, Address, Bytes, Symbol};

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

    // ─── E06 — Staking & Slashing (docs/STAKING_DESIGN.md) ─────────────
    /// A keeper's currently-bonded stake. Excludes anything mid-unbond —
    /// see [`UnbondRequest`]. Stored under its own key, never conflated
    /// with `KeeperReward`, mirroring the same separation-of-concerns
    /// reasoning that already keeps `FeesAccrued` distinct from task
    /// escrow (docs/STAKING_DESIGN.md §2).
    KeeperStake(Address),
    /// At most one pending unbond request per keeper.
    UnbondRequest(Address),
    /// Configurable minimum stake `claim_task` enforces, if any. Default 0
    /// (no requirement), mirroring `MinReward`. See
    /// docs/STAKING_DESIGN.md §6.
    MinStake,
    /// Monotonic id source for `Slash(u64)` records, mirroring
    /// `TaskCounter`.
    SlashCounter,
    /// One record per `slash` call, looked up by `raise_slash_appeal` /
    /// `resolve_slash_appeal`. See docs/STAKING_DESIGN.md §4.1.
    Slash(u64),
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

// ─── E01 — Contract Core Hardening ─────────────────────────────────────

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

// ─── E05 — Batch Operations & Gas ──────────────────────────────────────

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

// ─── E06 — Staking & Slashing ───────────────────────────────────────────

/// A keeper's pending stake withdrawal, started by `initiate_unbond` and
/// only releasable via `withdraw_stake` once `unlock_ledger` has passed.
/// See docs/STAKING_DESIGN.md §3.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnbondRequest {
    pub amount: i128,
    /// First ledger sequence at which `withdraw_stake` will accept this
    /// request — inclusive, mirroring `lock_expired`'s `>=` boundary.
    pub unlock_ledger: u32,
}

/// One record of a `slash` call, kept so `raise_slash_appeal` /
/// `resolve_slash_appeal` can reference it by `slash_id` and so an appeal
/// can be applied at most once per incident. See docs/STAKING_DESIGN.md §4-5.
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SlashRecord {
    pub keeper: Address,
    pub amount: i128,
    pub reason: Symbol,
    /// Ledger sequence the slash occurred at — the appeal window is
    /// `DISPUTE_WINDOW_LEDGERS` from this value.
    pub ledger: u32,
    /// True once an appeal has been raised for this slash — a second
    /// `raise_slash_appeal` for the same `slash_id` is rejected rather
    /// than silently accepted, so a slash can be appealed at most once.
    pub appealed: bool,
}
