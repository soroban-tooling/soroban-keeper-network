//! Reference time-window condition contract.
//!
//! A task carrying this condition becomes claimable only when the current
//! ledger timestamp falls within the configured window:
//!
//! ```text
//!   start <= env.ledger().timestamp() < end
//! ```
//!
//! `start` is inclusive; `end` is exclusive. Both are Unix timestamps in
//! seconds, matching `soroban_sdk::Env::ledger().timestamp()`.
//!
//! This contract is the simplest useful second reference condition after the
//! price-threshold (issue 0397). It doubles as a minimal template for
//! condition authors: one `initialize` entry point that validates and stores
//! configuration once, and one `check` entry point that implements `ICondition`
//! and never panics.
//!
//! # Interface
//!
//! The `ICondition` trait is declared here and mirrors the shape of
//! `IKeeperVerifier` in `contracts/keeper-registry/src/verifier.rs`. When a
//! shared conditions crate lands (issue 0390), the trait declaration here can
//! be replaced with a re-export without changing any call sites.

#![no_std]

use soroban_sdk::{contract, contractclient, contracterror, contractimpl, contracttype, Env};



// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/// Ledgers of instance-storage lifetime requested on `initialize`. Matches
/// `INSTANCE_BUMP_LEDGERS` in `contracts/keeper-registry/src/constants.rs`
/// (~6 days at 5 s/ledger).
pub const CONDITION_BUMP_LEDGERS: u32 = 100_000;

/// Renew instance TTL only once fewer than this many ledgers remain. Matches
/// `INSTANCE_BUMP_THRESHOLD` in the registry.
pub const CONDITION_BUMP_THRESHOLD: u32 = 50_000;

// -----------------------------------------------------------------------------
// ICondition interface
//
// Declared here so the time-window contract is self-contained. The registry's
// `claim_task` constructs a `ConditionClient` and calls `try_check`, treating
// any non-`Ok(Ok(true))` result as false — the same pattern `execute_task`
// uses for `KeeperVerifierClient::try_verify`.
// -----------------------------------------------------------------------------

/// Cross-contract interface the keeper registry's `claim_task` calls when a
/// task carries a condition address.
///
/// `task_id` is included so future condition contracts that need to inspect
/// the task's own fields (owner, deadline, etc.) can do so via a registry
/// view call, without coupling this interface to registry internals.
#[contractclient(name = "ConditionClient")]
pub trait ICondition {
    /// Returns `true` if the task's condition is currently met and the claim
    /// may proceed.  Must never panic — any error path must return `false`.
    fn check(env: Env, task_id: u64) -> bool;
}

// -----------------------------------------------------------------------------
// Error type
// -----------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ConditionError {
    /// `initialize` has already been called on this contract instance.
    /// Configuration is immutable after the first call.
    AlreadyInitialized = 1,
    /// `end` must be strictly greater than `start`. Equal or reversed values
    /// describe a zero-width or negative window that can never be entered.
    InvalidWindow = 2,
}

// -----------------------------------------------------------------------------
// Storage keys
// -----------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Unix timestamp (seconds, inclusive) at which the window opens.
    Start,
    /// Unix timestamp (seconds, exclusive) at which the window closes.
    End,
    /// Set to `true` after `initialize` succeeds; guards against re-init.
    Initialized,
}

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

#[contract]
pub struct TimeWindowCondition;

#[contractimpl]
impl TimeWindowCondition {
    // -- initialize -----------------------------------------------------------
    //
    // Configure the time window. Must be called exactly once; subsequent calls
    // are rejected with `AlreadyInitialized` so the owner cannot silently
    // shift the window after keepers have evaluated the task.
    //
    // `start` and `end` are Unix timestamps in seconds (the same unit that
    // `env.ledger().timestamp()` returns). `end` must be strictly greater than
    // `start`: a zero-width window (start == end) or a reversed window
    // (end < start) can never be satisfied and is rejected immediately.
    //
    // `max_staleness_seconds = 0` is not a concept here (unlike the
    // oracle-price-threshold condition); this contract has no staleness
    // concern.

    pub fn initialize(env: Env, start: u64, end: u64) -> Result<(), ConditionError> {
        // Guard: reject a second initialization attempt.
        if env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Initialized)
            .unwrap_or(false)
        {
            return Err(ConditionError::AlreadyInitialized);
        }

        // Validate: end must be strictly after start.
        if end <= start {
            return Err(ConditionError::InvalidWindow);
        }

        // Store configuration in Persistent storage.
        env.storage().persistent().set(&DataKey::Start, &start);
        env.storage().persistent().set(&DataKey::End, &end);
        env.storage().persistent().set(&DataKey::Initialized, &true);

        // Extend instance TTL so the contract stays live for the duration it
        // will be queried.
        env.storage()
            .instance()
            .extend_ttl(CONDITION_BUMP_THRESHOLD, CONDITION_BUMP_LEDGERS);

        Ok(())
    }

    // -- check ----------------------------------------------------------------
    //
    // Returns `true` if the current ledger timestamp falls inside the window:
    //   start <= now < end
    //
    // Fails closed (returns `false`) for every error case:
    //   - Called before `initialize` (not configured ? cannot be trusted)
    //   - Current time is before `start` (window not yet open)
    //   - Current time is at or after `end` (window has closed)
    //
    // Never panics: a condition contract that could panic would be treated
    // the same as a `false` return by the registry's `try_check`, but a panic
    // leaks budget and produces a confusing host error rather than a typed
    // response, so panics must be avoided entirely.

    pub fn check(env: Env, _task_id: u64) -> bool {
        // Fail closed if not yet initialised.
        if !env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Initialized)
            .unwrap_or(false)
        {
            return false;
        }

        // Load window bounds. Both keys are guaranteed present after a
        // successful `initialize`, so `unwrap_or` with a sentinel value that
        // fails closed is the safe default (matches the design's posture).
        let start: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Start)
            .unwrap_or(u64::MAX);
        let end: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::End)
            .unwrap_or(0);

        let now = env.ledger().timestamp();

        // start inclusive, end exclusive.
        now >= start && now < end
    }
}

// -----------------------------------------------------------------------------
// Test module
// -----------------------------------------------------------------------------

#[cfg(test)]
mod test;
