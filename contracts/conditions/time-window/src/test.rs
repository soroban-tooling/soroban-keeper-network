//! Tests for the time-window condition contract.
//!
//! Covers every branch of `check` and every error path in `initialize`,
//! including the exact boundaries the issue's acceptance criteria require:
//! before the window, inside it, after it, at `start` (inclusive), and at
//! `end` (exclusive).

use soroban_sdk::{testutils::Ledger as _, Env};

use crate::{ConditionError, TimeWindowCondition, TimeWindowConditionClient};

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Creates a fresh environment with its ledger timestamp set to `now`.
fn env_at(now: u64) -> Env {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = now);
    env
}

/// Registers the contract, calls `initialize(start, end)`, and returns the
/// client.  Panics if `initialize` returns an error (test setup failure).
fn setup(env: &Env, start: u64, end: u64) -> TimeWindowConditionClient {
    let id = env.register(TimeWindowCondition, ());
    let client = TimeWindowConditionClient::new(env, &id);
    client.initialize(&start, &end);
    client
}

// ─── check: window position ───────────────────────────────────────────────

#[test]
fn test_check_inside_window() {
    // now is strictly between start and end → true
    let start = 1_000u64;
    let end = 2_000u64;
    let env = env_at(start + 1); // now = 1_001
    let client = setup(&env, start, end);
    assert!(client.check(&0u64));
}

#[test]
fn test_check_before_window() {
    // now is before start → false
    let start = 1_000u64;
    let end = 2_000u64;
    let env = env_at(start - 1); // now = 999
    let client = setup(&env, start, end);
    assert!(!client.check(&0u64));
}

#[test]
fn test_check_after_window() {
    // now is past end → false
    let start = 1_000u64;
    let end = 2_000u64;
    let env = env_at(end + 1); // now = 2_001
    let client = setup(&env, start, end);
    assert!(!client.check(&0u64));
}

// ─── check: exact boundaries ─────────────────────────────────────────────

#[test]
fn test_check_at_start_boundary() {
    // now == start: start is inclusive, so check returns true
    let start = 1_000u64;
    let end = 2_000u64;
    let env = env_at(start);
    let client = setup(&env, start, end);
    assert!(
        client.check(&0u64),
        "start boundary is inclusive: now == start should return true"
    );
}

#[test]
fn test_check_at_end_boundary() {
    // now == end: end is exclusive, so check returns false
    let start = 1_000u64;
    let end = 2_000u64;
    let env = env_at(end);
    let client = setup(&env, start, end);
    assert!(
        !client.check(&0u64),
        "end boundary is exclusive: now == end should return false"
    );
}

// ─── check: uninitialized ────────────────────────────────────────────────

#[test]
fn test_check_before_initialize() {
    // check without initialize must fail closed, not panic
    let env = env_at(1_500);
    let id = env.register(TimeWindowCondition, ());
    let client = TimeWindowConditionClient::new(&env, &id);
    assert!(
        !client.check(&0u64),
        "check on an uninitialized contract must return false"
    );
}

// ─── initialize: error paths ─────────────────────────────────────────────

#[test]
fn test_initialize_invalid_window_end_equals_start() {
    // end == start is a zero-width window → InvalidWindow
    let env = env_at(0);
    let id = env.register(TimeWindowCondition, ());
    let client = TimeWindowConditionClient::new(&env, &id);
    let result = client.try_initialize(&1_000u64, &1_000u64);
    assert_eq!(
        result,
        Err(Ok(ConditionError::InvalidWindow)),
        "end == start must return InvalidWindow"
    );
}

#[test]
fn test_initialize_invalid_window_end_before_start() {
    // end < start is a reversed window → InvalidWindow
    let env = env_at(0);
    let id = env.register(TimeWindowCondition, ());
    let client = TimeWindowConditionClient::new(&env, &id);
    let result = client.try_initialize(&2_000u64, &1_000u64);
    assert_eq!(
        result,
        Err(Ok(ConditionError::InvalidWindow)),
        "end < start must return InvalidWindow"
    );
}

#[test]
fn test_initialize_already_initialized() {
    // second call to initialize must return AlreadyInitialized
    let env = env_at(0);
    let client = setup(&env, 1_000, 2_000);
    let result = client.try_initialize(&3_000u64, &4_000u64);
    assert_eq!(
        result,
        Err(Ok(ConditionError::AlreadyInitialized)),
        "second initialize must return AlreadyInitialized"
    );
    // configuration must be unchanged — still the original window
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    assert!(
        client.check(&0u64),
        "original window must still be in effect after rejected re-init"
    );
}
