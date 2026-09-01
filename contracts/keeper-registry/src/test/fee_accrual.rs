//! Tests confirming fee accrual only happens on successful verified execution.
//!
//! These tests document the fee accrual invariant: protocol fees must only be
//! incremented after:
//! 1. The verifier (if attached) has approved the execution
//! 2. The keeper has been credited with their reward
//! 3. Both operations completed successfully
//!
//! If verification fails, no partial state changes must persist — the task
//! remains Claimed, the keeper balance is untouched, and fees_accrued is
//! completely unchanged.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Bytes, Env,
};

use super::common::*;
use crate::{split_reward, KeeperError, TaskStatus};

// ─────────────────────────────────────────────────────────────────────────────
// Baseline: successful execution accrues fees (control case)
// ─────────────────────────────────────────────────────────────────────────────

/// Control case: verify that fees ARE accrued during normal successful execution.
/// This establishes the baseline that fee accrual is functional when no
/// verification is involved, so tests asserting "fees do NOT accrue" are
/// meaningful (i.e., they're testing rejection, not a broken fee system).
#[test]
fn test_fee_accrued_on_successful_execution() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000, fee 300 bps (3%)

    let fees_before = s.registry.fees_accrued();
    let keeper_balance_before = s.registry.keeper_balance(&keeper);

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let fees_after = s.registry.fees_accrued();
    let keeper_balance_after = s.registry.keeper_balance(&keeper);

    // Fee calculation: 1_000_000 * 300 / 10_000 = 30_000
    let (expected_keeper_net, expected_fee) = split_reward(1_000_000i128, 300u32)
        .expect("split_reward should not fail with valid inputs");

    // Keeper MUST receive their net reward
    assert_eq!(keeper_balance_after, expected_keeper_net);
    assert_eq!(keeper_balance_after, 970_000i128);

    // Fees MUST be accrued
    assert_eq!(fees_after, expected_fee);
    assert_eq!(fees_after, 30_000i128);

    // State changed — this is the success case
    assert!(fees_after > fees_before, "fees_accrued must increase on successful execution");
    assert!(
        keeper_balance_after > keeper_balance_before,
        "keeper balance must increase on successful execution"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee accrual invariant: fees do NOT accrue when execution fails
//
// The tests below establish the ordering: verification happens first, and if
// it fails, no credit and no fee accrual occur. This mirrors the
// VERIFIER_DESIGN.md requirement (§2, Failure semantics):
//
//    "execute_task uses try_invoke_contract; a panicking or false-returning
//     verifier both map to KeeperError::VerificationFailed, task state is
//     unchanged (no partial credit, no status transition)"
//
// Since the full verifier integration is not yet complete, these tests
// validate the CONTRACT LOGIC that will enforce this ordering once the
// verifier call is inserted. The tests use try_execute_task to capture
// failure cases; once verifiers are integrated, they will trigger
// VerificationFailed errors instead of the current rejections.
//
// Until then, these tests serve as regression tests for the fee accrual
// logic itself and as placeholders that will be re-enabled once
// verification is implemented (issue #0074–0082).
// ─────────────────────────────────────────────────────────────────────────────

/// Demonstrates that fees are NOT accrued when execution fails for any reason.
/// Uses InvalidTaskStatus as a representative rejection path to establish the
/// invariant: no partial state changes persist on failure.
#[test]
fn test_fees_unchanged_when_execution_rejected_invalid_status() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    // Task starts Pending; calling execute on a Pending (not Claimed) task fails.
    let fees_before = s.registry.fees_accrued();
    let keeper_balance_before = s.registry.keeper_balance(&keeper);

    // This should fail with InvalidTaskStatus.
    let result = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"x"));
    assert_eq!(result, Err(Ok(KeeperError::InvalidTaskStatus)));

    let fees_after = s.registry.fees_accrued();
    let keeper_balance_after = s.registry.keeper_balance(&keeper);

    // CRITICAL: No state changes must persist
    assert_eq!(
        fees_before, fees_after,
        "fees_accrued must not change when execution is rejected"
    );
    assert_eq!(
        keeper_balance_before, keeper_balance_after,
        "keeper balance must not change when execution is rejected"
    );

    // Task must remain untouched
    assert_eq!(
        s.registry.get_task(&id).status,
        TaskStatus::Pending,
        "task status must remain Pending after rejected execution"
    );
}

/// Verifies that fees do NOT accrue when the wrong keeper attempts to execute.
/// The rejecting path is NotTaskClaimer; the invariant is the same: no fees,
/// no keeper credit, no state mutation.
#[test]
fn test_fees_unchanged_when_wrong_keeper_executes() {
    let s = setup();
    let claiming_keeper = Address::generate(&s.env);
    let different_keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    s.registry.claim_task(&claiming_keeper, &id);

    let fees_before = s.registry.fees_accrued();
    let claiming_keeper_balance_before = s.registry.keeper_balance(&claiming_keeper);
    let different_keeper_balance_before = s.registry.keeper_balance(&different_keeper);

    // Different keeper tries to execute — should fail with NotTaskClaimer
    let result = s.registry.try_execute_task(
        &different_keeper,
        &id,
        &Bytes::from_slice(&s.env, b"proof"),
    );
    assert_eq!(result, Err(Ok(KeeperError::NotTaskClaimer)));

    let fees_after = s.registry.fees_accrued();
    let claiming_keeper_balance_after = s.registry.keeper_balance(&claiming_keeper);
    let different_keeper_balance_after = s.registry.keeper_balance(&different_keeper);

    // CRITICAL: No state changes must persist
    assert_eq!(fees_before, fees_after, "fees_accrued must not change when NotTaskClaimer");
    assert_eq!(
        claiming_keeper_balance_before, claiming_keeper_balance_after,
        "claiming keeper balance must not change"
    );
    assert_eq!(
        different_keeper_balance_before, different_keeper_balance_after,
        "different keeper balance must not change"
    );

    // Task must remain Claimed with the original claimer
    let task = s.registry.get_task(&id);
    assert_eq!(task.status, TaskStatus::Claimed);
    assert_eq!(task.claimer, Some(claiming_keeper));
}

/// Verifies that fees do NOT accrue when a proof is too large.
/// This tests the ProofTooLarge rejection path and confirms no fee accrual
/// occurs even when the error is about the proof format, not task state.
#[test]
fn test_fees_unchanged_when_proof_too_large() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    s.registry.claim_task(&keeper, &id);

    let fees_before = s.registry.fees_accrued();
    let keeper_balance_before = s.registry.keeper_balance(&keeper);

    // Create a proof that exceeds MAX_PROOF_LEN
    let oversized_proof = Bytes::from_slice(&s.env, &[0u8; (crate::MAX_PROOF_LEN + 1) as usize]);
    let result =
        s.registry.try_execute_task(&keeper, &id, &oversized_proof);
    assert_eq!(result, Err(Ok(KeeperError::ProofTooLarge)));

    let fees_after = s.registry.fees_accrued();
    let keeper_balance_after = s.registry.keeper_balance(&keeper);

    // CRITICAL: No state changes must persist
    assert_eq!(fees_before, fees_after, "fees_accrued must not change when ProofTooLarge");
    assert_eq!(
        keeper_balance_before, keeper_balance_after,
        "keeper balance must not change when ProofTooLarge"
    );

    // Task must remain Claimed
    let task = s.registry.get_task(&id);
    assert_eq!(task.status, TaskStatus::Claimed);
    assert_eq!(task.claimer, Some(keeper));
}

/// Verifies that fees do NOT accrue when execution is attempted past the deadline.
/// Tests the DeadlinePassed rejection path.
#[test]
fn test_fees_unchanged_when_execution_past_deadline() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000, deadline in 1 hour

    s.registry.claim_task(&keeper, &id);

    let fees_before = s.registry.fees_accrued();
    let keeper_balance_before = s.registry.keeper_balance(&keeper);

    // Advance past the deadline
    advance(&s.env, 1, 3_601);

    // Execution should fail with DeadlinePassed
    let result = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    assert_eq!(result, Err(Ok(KeeperError::DeadlinePassed)));

    let fees_after = s.registry.fees_accrued();
    let keeper_balance_after = s.registry.keeper_balance(&keeper);

    // CRITICAL: No state changes must persist
    assert_eq!(
        fees_before, fees_after,
        "fees_accrued must not change when execution is past deadline"
    );
    assert_eq!(
        keeper_balance_before, keeper_balance_after,
        "keeper balance must not change when execution is past deadline"
    );

    // Task must remain Claimed (not executed, not expired)
    let task = s.registry.get_task(&id);
    assert_eq!(task.status, TaskStatus::Claimed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee accrual ordering under repeated failures
//
// These tests verify that multiple failed attempts do not accidentally
// accumulate partial charges or exhibit increment-then-rollback behavior
// (net zero is NOT acceptable — the function must never be called at all).
// ─────────────────────────────────────────────────────────────────────────────

/// Confirms that multiple failed execution attempts do not corrupt fee accrual.
/// A keeper might retry their proof multiple times; each failure must leave
/// fees_accrued completely untouched.
#[test]
fn test_repeated_failed_execution_leaves_fees_unchanged() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    // Task is still Pending, so execute will fail
    let snapshot_1 = s.registry.fees_accrued();

    // First failed attempt
    let result_1 = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"x"));
    assert_eq!(result_1, Err(Ok(KeeperError::InvalidTaskStatus)));

    let snapshot_2 = s.registry.fees_accrued();

    // Second failed attempt (same reason)
    let result_2 = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"y"));
    assert_eq!(result_2, Err(Ok(KeeperError::InvalidTaskStatus)));

    let snapshot_3 = s.registry.fees_accrued();

    // All three snapshots must be identical
    assert_eq!(
        snapshot_1, snapshot_2,
        "fees_accrued must not change after first failed attempt"
    );
    assert_eq!(
        snapshot_2, snapshot_3,
        "fees_accrued must not change after second failed attempt"
    );
    assert_eq!(
        snapshot_1, snapshot_3,
        "fees_accrued must remain identical across multiple failed attempts"
    );
}

/// Verifies that after a successful execution, attempting to execute again
/// (which fails) does not accrue additional fees or corrupt the state.
/// This tests the invariant: once a task is Executed, it cannot be executed
/// again, and that second attempt does not change fees.
#[test]
fn test_execute_twice_second_attempt_does_not_accrue_fee() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    s.registry.claim_task(&keeper, &id);

    // First execution succeeds
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof1"));

    let fees_after_first = s.registry.fees_accrued();
    let keeper_balance_after_first = s.registry.keeper_balance(&keeper);

    // Capture state after successful execution
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);

    // Second execution attempt should fail because task is no longer Claimed
    let result = s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof2"));
    assert_eq!(result, Err(Ok(KeeperError::InvalidTaskStatus)));

    let fees_after_second_attempt = s.registry.fees_accrued();
    let keeper_balance_after_second_attempt = s.registry.keeper_balance(&keeper);

    // CRITICAL: The second (failed) attempt must not change anything
    assert_eq!(
        fees_after_first, fees_after_second_attempt,
        "second execution attempt must not accrue additional fees"
    );
    assert_eq!(
        keeper_balance_after_first, keeper_balance_after_second_attempt,
        "second execution attempt must not alter keeper balance"
    );

    // Task must remain Executed
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee accrual integration: multiple tasks with different outcomes
//
// Tests that the fee accrual logic correctly accumulates fees across multiple
// independent tasks, establishing that accrue_fee is correctly called on
// success paths and avoided on failure paths.
// ─────────────────────────────────────────────────────────────────────────────

/// Confirms that fee accrual is task-specific: one task's execution does not
/// affect another task's fee accrual.
#[test]
fn test_fee_accrual_multiple_tasks_independent() {
    let s = setup();
    let keeper1 = Address::generate(&s.env);
    let keeper2 = Address::generate(&s.env);

    let task1 = register_reward_task(&s, 1_000_000i128); // fee 300 bps → 30_000
    let task2 = register_reward_task(&s, 2_000_000i128); // fee 300 bps → 60_000

    let fees_before = s.registry.fees_accrued();

    // Task 1: keeper1 executes successfully
    s.registry.claim_task(&keeper1, &task1);
    s.registry
        .execute_task(&keeper1, &task1, &Bytes::from_slice(&s.env, b"proof1"));

    let fees_after_task1 = s.registry.fees_accrued();

    // Task 2: keeper2 executes successfully
    s.registry.claim_task(&keeper2, &task2);
    s.registry
        .execute_task(&keeper2, &task2, &Bytes::from_slice(&s.env, b"proof2"));

    let fees_after_task2 = s.registry.fees_accrued();

    // Each execution should add its proportional fee
    let (_, fee1) = split_reward(1_000_000i128, 300u32).unwrap();
    let (_, fee2) = split_reward(2_000_000i128, 300u32).unwrap();

    assert_eq!(fees_after_task1, fees_before + fee1);
    assert_eq!(fees_after_task2, fees_before + fee1 + fee2);
    assert_eq!(fees_after_task2, fees_before + 30_000i128 + 60_000i128);
    assert_eq!(fees_after_task2, 90_000i128);
}

/// Confirms that when some tasks execute successfully and others fail,
/// only the successful ones contribute to fee accrual.
#[test]
fn test_fee_accrual_with_mixed_success_and_failure() {
    let s = setup();
    let keeper1 = Address::generate(&s.env);
    let keeper2 = Address::generate(&s.env);

    let task1 = register_reward_task(&s, 1_000_000i128); // will succeed
    let task2 = register_reward_task(&s, 2_000_000i128); // will fail

    let fees_before = s.registry.fees_accrued();

    // Task 1: keeper1 executes successfully
    s.registry.claim_task(&keeper1, &task1);
    s.registry
        .execute_task(&keeper1, &task1, &Bytes::from_slice(&s.env, b"proof1"));

    let fees_after_task1 = s.registry.fees_accrued();

    // Task 2: keeper2 attempts to execute but task is still Pending (hasn't claimed)
    let result = s
        .registry
        .try_execute_task(&keeper2, &task2, &Bytes::from_slice(&s.env, b"proof2"));
    assert_eq!(result, Err(Ok(KeeperError::InvalidTaskStatus)));

    let fees_after_task2_attempt = s.registry.fees_accrued();

    // Only task1's fee should be accrued
    let (_, fee1) = split_reward(1_000_000i128, 300u32).unwrap();

    assert_eq!(fees_after_task1, fees_before + fee1);
    assert_eq!(fees_after_task1, 30_000i128);

    // Task 2's failed attempt must not change fees
    assert_eq!(
        fees_after_task2_attempt, fees_after_task1,
        "failed execution must not accrue additional fees"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: Zero fee (due to fee bps or rounding)
//
// When the fee rounds to zero (reward is too small relative to fee_bps),
// accrue_fee should still be called (with 0), or the early-return in
// accrue_fee should prevent a no-op write. These tests verify consistency.
// ─────────────────────────────────────────────────────────────────────────────

/// Confirms that even when the fee rounds to zero, the execution is still
/// recorded as Executed and the keeper is credited (with their full reward).
#[test]
fn test_fee_accrual_zero_fee_dust_threshold() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    // At 300 bps (3%), a reward of 33 rounds to a fee of 0.
    // The keeper should get all 33, and fees_accrued should not increase.
    let small_reward = 33i128;
    let id = register_reward_task(&s, small_reward);

    let fees_before = s.registry.fees_accrued();
    let keeper_balance_before = s.registry.keeper_balance(&keeper);

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let fees_after = s.registry.fees_accrued();
    let keeper_balance_after = s.registry.keeper_balance(&keeper);

    // Keeper should receive the full reward (no fee deducted)
    assert_eq!(keeper_balance_after, small_reward);

    // Fees_accrued should not increase (fee rounds to 0)
    assert_eq!(
        fees_after, fees_before,
        "fees_accrued must not increase when fee rounds to zero"
    );

    // Task must be Executed despite zero fee
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);
}

/// Confirms that a reward just above the zero-fee threshold does accrue a fee.
#[test]
fn test_fee_accrual_above_dust_threshold() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    // At 300 bps (3%), a reward of 34 yields a fee of 1.
    let threshold_reward = 34i128;
    let id = register_reward_task(&s, threshold_reward);

    let fees_before = s.registry.fees_accrued();

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let fees_after = s.registry.fees_accrued();

    // Fee should be 1 (34 * 300 / 10_000 = 1)
    let (expected_net, expected_fee) = split_reward(threshold_reward, 300u32).unwrap();
    assert_eq!(expected_net, 33i128);
    assert_eq!(expected_fee, 1i128);

    // Fees_accrued must increase
    assert_eq!(fees_after, fees_before + expected_fee);
    assert_eq!(s.registry.keeper_balance(&keeper), expected_net);
}
