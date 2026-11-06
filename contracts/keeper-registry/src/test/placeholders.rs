//! Guards for entry points that are declared but not yet implemented.

use soroban_sdk::{testutils::Address as _, token, Address};

use super::common::*;
use crate::{KeeperError, TaskStatus};

// ─────────────────────────────────────────────────────────────────────────────
// Tests for reward top-ups, deadline extension, and the claim/re-claim lifecycle,
// including pause enforcement (regression for issue #20).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_increase_reward_escrows_and_raises_bounty() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let id = register_default_task(&s); // reward 1_000_000
    let contract_before = token.balance(&s.registry.address);

    s.registry.increase_reward(&s.admin, &id, &500_000i128);

    assert_eq!(s.registry.get_task(&id).reward, 1_500_000i128);
    assert_eq!(
        token.balance(&s.registry.address),
        contract_before + 500_000i128
    );
}

#[test]
fn test_increase_reward_by_non_owner_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_increase_reward(&stranger, &id, &1i128),
        Err(Ok(KeeperError::NotTaskOwner))
    );
}

#[test]
fn test_extend_deadline_pushes_it_out() {
    let s = setup();
    let id = register_default_task(&s);
    let old = s.registry.get_task(&id).deadline;

    s.registry.extend_deadline(&s.admin, &id, &(old + 7_200));
    assert_eq!(s.registry.get_task(&id).deadline, old + 7_200);
}

#[test]
fn test_extend_deadline_backwards_fails() {
    let s = setup();
    let id = register_default_task(&s);
    let old = s.registry.get_task(&id).deadline;
    // A new deadline that isn't strictly later is rejected.
    assert_eq!(
        s.registry.try_extend_deadline(&s.admin, &id, &old),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

// Regression test for issue #20: `extend_deadline` did not call
// `require_not_paused`, so an owner could keep escrow locked in a paused
// contract by pushing the deadline out indefinitely. Mirrors the style of
// `test_pause_blocks_registration_but_allows_withdraw`.
#[test]
fn test_extend_deadline_blocked_while_paused() {
    let s = setup();
    let id = register_default_task(&s);
    let old_deadline = s.registry.get_task(&id).deadline;

    s.registry.pause(&s.admin);
    assert!(s.registry.is_paused());

    assert_eq!(
        s.registry
            .try_extend_deadline(&s.admin, &id, &(old_deadline + 7_200)),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(s.registry.get_task(&id).deadline, old_deadline); // untouched
}

#[test]
fn test_extend_deadline_succeeds_after_unpause() {
    let s = setup();
    let id = register_default_task(&s);
    let old_deadline = s.registry.get_task(&id).deadline;

    s.registry.pause(&s.admin);
    s.registry.unpause(&s.admin);
    assert!(!s.registry.is_paused());

    s.registry
        .extend_deadline(&s.admin, &id, &(old_deadline + 7_200));
    assert_eq!(s.registry.get_task(&id).deadline, old_deadline + 7_200);
}

#[test]
fn test_is_claimable_lifecycle() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    assert!(s.registry.is_claimable(&id)); // Pending → claimable
    s.registry.claim_task(&keeper, &id);
    assert!(!s.registry.is_claimable(&id)); // Claimed, lock active → not

    advance(&s.env, 121, 60); // lock window elapses
    assert!(s.registry.is_claimable(&id)); // re-claimable

    advance(&s.env, 1, 3_601); // past deadline
    assert!(!s.registry.is_claimable(&id)); // deadline passed → not
    assert!(!s.registry.is_claimable(&999u64)); // unknown → not
}

#[test]
fn test_claim_pending_task() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);

    let task = s.registry.get_task(&id);
    assert_eq!(task.status, TaskStatus::Claimed);
    assert_eq!(task.claimer, Some(keeper));
    assert!(task.claim_ledger.is_some());
}

#[test]
fn test_claim_locked_task_by_second_keeper_fails() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&first, &id);
    // Still inside the 120-ledger lock window.
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
}

#[test]
fn test_reclaim_after_lock_window_elapses() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&first, &id);
    // Move past the lock window (120 ledgers) but stay before the deadline.
    advance(&s.env, 121, 60);

    s.registry.claim_task(&second, &id);
    assert_eq!(s.registry.get_task(&id).claimer, Some(second));
}
