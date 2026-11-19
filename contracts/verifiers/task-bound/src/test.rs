use keeper_registry_test_support::{KeeperError, TaskStatus, VerifierTestHarness};
use soroban_sdk::{testutils::Ledger as _, Bytes};

use crate::TaskBoundVerifier;

/// Registers a task with this verifier attached and claims it.
fn claimed_task(harness: &VerifierTestHarness) -> u64 {
    let env = harness.env();
    let verifier = env.register(TaskBoundVerifier, ());
    let task_id = harness
        .register_task_with_verifier(
            harness.owner_address(),
            Some(verifier),
            1_000_000,
            env.ledger().timestamp() + 3_600,
            &Bytes::new(env),
        )
        .unwrap();
    harness
        .claim_task(harness.keeper_address(), task_id)
        .unwrap();
    task_id
}

fn proof_for(harness: &VerifierTestHarness, task_id: u64) -> Bytes {
    let mut proof = Bytes::from_slice(harness.env(), b"done:");
    proof.extend_from_array(&task_id.to_be_bytes());
    proof
}

#[test]
fn approves_a_proof_bound_to_the_task() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);

    harness
        .execute_task(
            harness.keeper_address(),
            task_id,
            &proof_for(&harness, task_id),
        )
        .unwrap();

    assert_eq!(harness.get_task(task_id).status, TaskStatus::Executed);
    assert_eq!(harness.keeper_balance(harness.keeper_address()), 1_000_000);
}

#[test]
fn rejects_a_wrong_proof_and_leaves_the_task_claimed() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);

    let result = harness.execute_task(
        harness.keeper_address(),
        task_id,
        &Bytes::from_slice(harness.env(), b"nope"),
    );

    assert_eq!(result, Err(KeeperError::VerificationFailed));
    assert_eq!(harness.get_task(task_id).status, TaskStatus::Claimed);
    assert_eq!(harness.keeper_balance(harness.keeper_address()), 0);
    assert_eq!(harness.fees_accrued(), 0);
}

#[test]
fn rejects_a_proof_replayed_from_another_task() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);

    let result = harness.execute_task(
        harness.keeper_address(),
        task_id,
        &proof_for(&harness, task_id + 1),
    );

    assert_eq!(result, Err(KeeperError::VerificationFailed));
}

#[test]
fn a_rejected_proof_can_be_retried() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);

    assert!(harness
        .execute_task(
            harness.keeper_address(),
            task_id,
            &Bytes::from_slice(harness.env(), b"nope"),
        )
        .is_err());
    harness
        .execute_task(
            harness.keeper_address(),
            task_id,
            &proof_for(&harness, task_id),
        )
        .unwrap();

    assert_eq!(harness.get_task(task_id).status, TaskStatus::Executed);
}

#[test]
fn deadline_still_applies_with_a_verifier_attached() {
    let harness = VerifierTestHarness::new();
    let task_id = claimed_task(&harness);
    let deadline = harness.get_task(task_id).deadline;
    harness.env().ledger().set_timestamp(deadline);

    let result = harness.execute_task(
        harness.keeper_address(),
        task_id,
        &proof_for(&harness, task_id),
    );

    assert_eq!(result, Err(KeeperError::DeadlinePassed));
}
