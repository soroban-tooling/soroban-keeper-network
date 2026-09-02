//! `claim_task` and the `lock_expired` boundary.

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token, Address, Bytes, TryIntoVal,
};

use super::common::*;
use crate::{split_reward, DataKey, KeeperError, TaskStatus, TaskType, MIN_LOCK_LEDGERS};

// ─────────────────────────────────────────────────────────────────────────────
// lock_expired boundary — pins the exact ledger the lock lifts, per issue #33.
// A small `lock_ledgers` (12, the protocol minimum) keeps the arithmetic easy
// to follow.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_lock_boundary_unlock_at_minus_one_is_still_locked() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let (id, unlock_at) = claim_with_lock(&s, &first, MIN_LOCK_LEDGERS);

    goto_ledger(&s.env, unlock_at - 1);

    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
}

#[test]
fn test_lock_boundary_at_unlock_at_is_reclaimable() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let (id, unlock_at) = claim_with_lock(&s, &first, MIN_LOCK_LEDGERS);

    goto_ledger(&s.env, unlock_at);

    // The `>=` in `lock_expired` makes the boundary inclusive: exactly at
    // `unlock_at`, the lock has already lifted.
    assert!(s.registry.is_claimable(&id));
    s.registry.claim_task(&second, &id);
    let task = s.registry.get_task(&id);
    assert_eq!(task.claimer, Some(second));
    assert_eq!(task.claim_ledger, Some(unlock_at));
}

#[test]
fn test_lock_boundary_unlock_at_plus_one_is_reclaimable() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let (id, unlock_at) = claim_with_lock(&s, &first, MIN_LOCK_LEDGERS);

    goto_ledger(&s.env, unlock_at + 1);

    assert!(s.registry.is_claimable(&id));
    s.registry.claim_task(&second, &id);
    assert_eq!(s.registry.get_task(&id).claimer, Some(second));
}

#[test]
fn test_lock_window_extending_past_deadline_is_blocked_by_deadline_first() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);

    // The lock window (1000 ledgers) would far outlive the 10-second deadline.
    let deadline = s.env.ledger().timestamp() + 10;
    let id = s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000i128,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &1_000u32,
        &None,
    );
    s.registry.claim_task(&first, &id);

    // Advance past the deadline but nowhere near the lock's unlock_at.
    advance(&s.env, 1, 11);
    assert!(s.env.ledger().timestamp() >= deadline);

    // The deadline check runs before the lock check in both `claim_task` and
    // `is_claimable`, so the takeover path is unreachable here: the failure
    // is DeadlinePassed, never LockPeriodActive.
    assert!(!s.registry.is_claimable(&id));
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_claim_past_deadline_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    advance(&s.env, 1, 3_601); // step past the 1-hour deadline
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_claim_unknown_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_claim_task(&keeper, &999u64),
        Err(Ok(KeeperError::TaskNotFound))
    );
}

#[test]
fn test_execute_task_credits_keeper_net_of_fee() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000, fee 300 bps (3%)

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    // 3% fee → keeper receives 970_000, contract retains 30_000 as fee.
    assert_eq!(s.registry.keeper_balance(&keeper), 970_000i128);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);
}

#[test]
fn test_get_fee_bps_matches_applied_fee_when_never_written() {
    let s = setup();
    // Simulate a registry where `FeeBps` was never written (e.g. queried
    // before `initialize`, or dropped by a future storage migration).
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().remove(&DataKey::FeeBps);
    });

    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    let reported_fee_bps = s.registry.get_fee_bps();

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let (expected_net, _) = split_reward(1_000_000i128, reported_fee_bps).unwrap();
    assert_eq!(s.registry.keeper_balance(&keeper), expected_net);
    assert_eq!(reported_fee_bps, 0u32);
}

#[test]
fn test_get_fee_bps_matches_applied_fee_after_set_fee_bps() {
    let s = setup();
    s.registry.set_fee_bps(&s.admin, &750u32);

    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000

    let reported_fee_bps = s.registry.get_fee_bps();

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let (expected_net, _) = split_reward(1_000_000i128, reported_fee_bps).unwrap();
    assert_eq!(s.registry.keeper_balance(&keeper), expected_net);
    assert_eq!(reported_fee_bps, 750u32);
}

#[test]
fn test_execute_task_emits_proof_in_event() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    let proof = Bytes::from_slice(&s.env, b"keeper-proof:task:1:tx:deadbeef");

    s.registry.claim_task(&keeper, &id);
    s.registry.execute_task(&keeper, &id, &proof);

    let (_contract, _topics, data) = s.env.events().all().last().unwrap();
    let (event_task_id, event_keeper, event_net, event_proof): (u64, Address, i128, Bytes) =
        data.try_into_val(&s.env).unwrap();

    assert_eq!(event_task_id, id);
    assert_eq!(event_keeper, keeper);
    assert_eq!(event_net, 970_000i128);
    assert_eq!(event_proof, proof);
}

#[test]
fn test_execute_task_over_max_proof_len_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);

    let oversized = Bytes::from_slice(&s.env, &[0u8; (crate::MAX_PROOF_LEN + 1) as usize]);
    assert_eq!(
        s.registry.try_execute_task(&keeper, &id, &oversized),
        Err(Ok(KeeperError::ProofTooLarge))
    );

    // The task is untouched by the rejected call — still claimable/executable.
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
    let at_limit = Bytes::from_slice(&s.env, &[0u8; crate::MAX_PROOF_LEN as usize]);
    s.registry.execute_task(&keeper, &id, &at_limit);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);
}

#[test]
fn test_execute_by_non_claimer_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    assert_eq!(
        s.registry
            .try_execute_task(&stranger, &id, &Bytes::from_slice(&s.env, b"x")),
        Err(Ok(KeeperError::NotTaskClaimer))
    );
}

#[test]
fn test_execute_unclaimed_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // still Pending

    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"x")),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

#[test]
fn test_execute_twice_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));
    // Second execution must fail — task is no longer Claimed.
    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p")),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

#[test]
fn test_execute_past_deadline_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    advance(&s.env, 1, 3_601); // deadline passes while claimed
    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p")),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_cancel_pending_task_refunds_owner() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let id = register_default_task(&s); // escrows 1_000_000
    assert_eq!(token.balance(&s.admin), before - 1_000_000i128);

    s.registry.cancel_task(&s.admin, &id);

    assert_eq!(token.balance(&s.admin), before); // fully refunded
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Cancelled);
}

#[test]
fn test_cancel_by_non_owner_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_cancel_task(&stranger, &id),
        Err(Ok(KeeperError::NotTaskOwner))
    );
}

#[test]
fn test_cancel_claimed_task_while_lock_active_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);

    // Advance 100 ledgers while lock period (default 120 ledgers) is still active
    advance(&s.env, 100, 0);

    // Owner cannot cancel while keeper holds an active lock window.
    assert_eq!(
        s.registry.try_cancel_task(&s.admin, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
}

#[test]
fn test_cancel_claimed_task_after_lock_lapsed_succeeds() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);

    // Advance ledgers past lock_ledgers (default 120 ledgers)
    advance(&s.env, 120, 0);

    // Owner reclaims escrow once claimer's lock window has lapsed
    s.registry.cancel_task(&s.admin, &id);

    assert_eq!(token.balance(&s.admin), before);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Cancelled);
}

#[test]
fn test_cancel_claimed_task_boundary_unlock_at_minus_one_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let (id, unlock_at) = claim_with_lock(&s, &keeper, 12u32);

    goto_ledger(&s.env, unlock_at - 1);

    // Lock is still active at unlock_at - 1
    assert_eq!(
        s.registry.try_cancel_task(&s.admin, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
}

#[test]
fn test_cancel_claimed_task_boundary_at_unlock_at_succeeds() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let (id, unlock_at) = claim_with_lock(&s, &keeper, 12u32);

    goto_ledger(&s.env, unlock_at);

    // Lock lapses at unlock_at, allowing task owner to cancel
    s.registry.cancel_task(&s.admin, &id);

    assert_eq!(token.balance(&s.admin), before);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Cancelled);
}

#[test]
fn test_cancel_claimed_task_boundary_unlock_at_plus_one_succeeds() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let (id, unlock_at) = claim_with_lock(&s, &keeper, 12u32);

    goto_ledger(&s.env, unlock_at + 1);

    // Lock is expired at unlock_at + 1
    s.registry.cancel_task(&s.admin, &id);

    assert_eq!(token.balance(&s.admin), before);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Cancelled);
}

#[test]
fn test_expire_after_deadline_refunds_owner() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id); // claimed but never executed

    advance(&s.env, 1, 3_601); // past deadline
                               // Permissionless: a third party can trigger the refund.
    s.registry.expire_task(&id);

    assert_eq!(token.balance(&s.admin), before); // owner made whole
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Expired);
}

#[test]
fn test_expire_before_deadline_fails() {
    let s = setup();
    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_expire_task(&id),
        Err(Ok(KeeperError::DeadlineNotPassed))
    );
}

#[test]
fn test_expire_executed_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));

    advance(&s.env, 1, 3_601);
    assert_eq!(
        s.registry.try_expire_task(&id),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}
