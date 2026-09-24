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
    // ─── E01 — Contract Core Hardening ─────────────────────────────────
    // Base task-lifecycle and admin errors. New variants for core
    // correctness/hardening work go here, at the next free discriminant.
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

    // ─── E04 — On-chain Execution Verifier ─────────────────────────────
    // New verifier-interface/verification errors go here.
    /// `proof` passed to `execute_task` exceeded `MAX_PROOF_LEN`.
    ProofTooLarge = 14,
    /// The attached verifier reported an `interface_version` other than
    /// [`KEEPER_VERIFIER_INTERFACE_VERSION`]. `verify` was not called.
    IncompatibleVerifierInterface = 20,
    /// A task's attached verifier rejected the proof (`verify` returned
    /// `false`, or the call panicked — the two are treated identically, see
    /// `docs/VERIFIER_DESIGN.md` §2). Distinct from `InvalidTaskStatus` (the
    /// task moved out from under the caller — don't retry the same way) and
    /// `NotTaskClaimer` (wrong caller): this means the caller IS the current
    /// claimer of a still-`Claimed` task, but the specific proof it submitted
    /// was rejected, so retrying with a different proof against the same
    /// claim is meaningful.
    VerificationFailed = 24,

    // ─── E05 — Batch Operations & Gas ──────────────────────────────────
    // New batch-registration/-read errors go here.
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

    // ─── E06 — Staking & Slashing (docs/STAKING_DESIGN.md) ─────────────
    // New staking/slashing errors go here.
    /// `slash` or `initiate_unbond` was asked for more than the keeper's
    /// current stake.
    InsufficientStake = 25,
    /// `withdraw_stake` called before the pending request's
    /// `unlock_ledger` has been reached.
    UnbondNotReady = 26,
    /// `initiate_unbond` called while a prior request for the same keeper
    /// has not yet been withdrawn.
    UnbondAlreadyPending = 27,
    /// `withdraw_stake` called with no `UnbondRequest` on file for the
    /// keeper.
    NoPendingUnbond = 28,
    /// `claim_task` rejected a keeper whose current stake is below the
    /// configured `MinStake` floor.
    MinStakeNotMet = 29,
    /// `raise_slash_appeal` / `resolve_slash_appeal` given a `slash_id`
    /// with no matching `Slash` record.
    SlashNotFound = 30,
    /// `raise_slash_appeal` called after `DISPUTE_WINDOW_LEDGERS` has
    /// elapsed since the slash it references.
    AppealWindowClosed = 31,
    /// A second `raise_slash_appeal` for a `slash_id` that already has one.
    AppealAlreadyRaised = 32,
    /// `raise_slash_appeal` called by an address other than the slash
    /// record's own `keeper` — only the slashed keeper has standing to
    /// dispute its own slash.
    NotSlashedKeeper = 33,
}
