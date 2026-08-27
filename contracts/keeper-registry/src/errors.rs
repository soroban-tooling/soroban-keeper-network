//! The contract's error enum.
//!
//! Discriminants are part of the published ABI: off-chain clients decode them
//! by number. Never renumber an existing variant, and allocate the next free
//! number when adding one.

use soroban_sdk::contracterror;

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
    /// `proof` passed to `execute_task` exceeded `MAX_PROOF_LEN`.
    ProofTooLarge = 14,
    /// A function requiring configured state (`initialize` must have been
    /// called) was invoked on a registry that isn't configured yet.
    NotInitialized = 15,
    /// `ttl_ledgers` does not cover the task's `deadline` plus the safety
    /// margin — the storage entry could expire while the escrow is still
    /// live. See [`required_ttl_ledgers`].
    TtlTooShort = 16,
    /// `calldata` exceeds [`MAX_CALLDATA_LEN`].
    CalldataTooLarge = 17,
    /// `lock_ledgers` or `ttl_ledgers` passed to `register_task` fell outside
    /// their allowed bounds.
    InvalidTaskParams = 18,
    /// Arithmetic operation would overflow or underflow.
    ArithmeticOverflow = 19,
    /// The attached verifier reported an `interface_version` other than
    /// [`KEEPER_VERIFIER_INTERFACE_VERSION`]. `verify` was not called.
    IncompatibleVerifierInterface = 20,
    /// A batch read (`get_tasks` / `get_tasks_range`) asked for more than
    /// [`MAX_BATCH_READ`] task ids, or `batch_register_tasks` was handed more
    /// entries than [`MAX_BATCH_SIZE`]. Returned rather than silently
    /// truncating, so a caller can never mistake a clipped page/batch for the
    /// end of a range — see `docs/BATCH_OPERATIONS.md` §4.
    BatchTooLarge = 21,
    /// `batch_register_tasks` was handed an empty `tasks` vector. Rejected
    /// rather than treated as a no-op so a caller whose off-chain filter
    /// produced nothing finds out, instead of paying for an auth and a
    /// transaction that registered nothing.
    EmptyBatch = 22,
    /// The sum of a batch's rewards exceeded the caller-supplied
    /// `max_total_reward` ceiling. Zero transfers occurred.
    BatchRewardCeilingExceeded = 23,
    /// A task's attached verifier rejected the proof (`verify` returned
    /// `false`, or the call panicked — the two are treated identically, see
    /// `docs/VERIFIER_DESIGN.md` §2). Distinct from `InvalidTaskStatus` (the
    /// task moved out from under the caller — don't retry the same way) and
    /// `NotTaskClaimer` (wrong caller): this means the caller IS the current
    /// claimer of a still-`Claimed` task, but the specific proof it submitted
    /// was rejected, so retrying with a different proof against the same
    /// claim is meaningful.
    VerificationFailed = 24,
}
