//! Reputation bookkeeping integrated with task success and expired claim takeover.

use soroban_sdk::{testutils::Address as _, Address, Bytes};

use super::common::*;
use crate::reputation::stored_record;
use crate::KeeperError;

fn record(s: &TestSetup, keeper: &Address) -> crate::reputation::ReputationRecord {
    s.env
        .as_contract(&s.registry.address, || stored_record(&s.env, keeper))
}

/// These tests jump several half-lives (100,000 ledgers each), past the
/// registry instance's 100,000-ledger bump, and the test host panics on an
/// archived instance. Extend it the way live traffic would keep it alive.
fn keep_registry_alive(s: &TestSetup) {
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().extend_ttl(1_000_000, 1_000_000);
    });
}

#[test]
fn successes_and_missed_lock_window_update_reputation() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let next_keeper = Address::generate(&s.env);

    for _ in 0..2 {
        let task_id = register_default_task(&s);
        s.registry.claim_task(&keeper, &task_id);
        s.registry
            .execute_task(&keeper, &task_id, &Bytes::from_slice(&s.env, b"proof"));
    }

    let missed_task = register_default_task(&s);
    s.registry.claim_task(&keeper, &missed_task);
    advance(&s.env, 120, 0);
    s.registry.claim_task(&next_keeper, &missed_task);

    let record = record(&s, &keeper);
    assert_eq!(record.successes, 2);
    assert_eq!(record.missed_claims, 1);
    assert_eq!(record.score_bps, 6_666);
    assert_eq!(record.last_updated_ledger, s.env.ledger().sequence());
}

#[test]
fn failed_or_rejected_actions_do_not_update_reputation() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let task_id = register_default_task(&s);

    s.registry.claim_task(&keeper, &task_id);
    assert_eq!(
        s.registry.try_execute_task(
            &keeper,
            &task_id,
            &Bytes::from_slice(&s.env, &[0; (crate::MAX_PROOF_LEN + 1) as usize]),
        ),
        Err(Ok(crate::KeeperError::ProofTooLarge))
    );

    let record = record(&s, &keeper);
    assert_eq!(record.successes, 0);
    assert_eq!(record.missed_claims, 0);
    assert_eq!(record.score_bps, 0);
}

#[test]
fn keeper_reputation_returns_stored_record_and_zero_for_new_keeper() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    assert_eq!(
        s.registry.keeper_reputation(&keeper),
        crate::ReputationRecord::zero()
    );

    let task_id = register_default_task(&s);
    s.registry.claim_task(&keeper, &task_id);
    s.registry
        .execute_task(&keeper, &task_id, &Bytes::from_slice(&s.env, b"proof"));

    let before = s.registry.keeper_reputation(&keeper);
    assert_eq!(before.successes, 1);
    assert_eq!(before.missed_claims, 0);
    assert_eq!(before.score_bps, 10_000);
    assert_eq!(s.registry.keeper_reputation(&keeper), before);
}

#[test]
fn effective_reputation_decays_at_exact_half_life_boundaries_without_writing() {
    let s = setup();
    let s = setup_long_lived();
    let keeper = Address::generate(&s.env);
    let task_id = register_default_task(&s);
    s.registry.claim_task(&keeper, &task_id);
    s.registry
        .execute_task(&keeper, &task_id, &Bytes::from_slice(&s.env, b"proof"));

    let stored = s.registry.keeper_reputation(&keeper);
    let half_life = crate::reputation::REPUTATION_DECAY_HALF_LIFE_LEDGERS;
    let origin = stored.last_updated_ledger;
    keep_registry_alive(&s);

    goto_ledger(&s.env, origin + half_life - 1);
    assert_eq!(s.registry.effective_reputation(&keeper).score_bps, 10_000);

    goto_ledger(&s.env, origin + half_life);
    let at_first_boundary = s.registry.effective_reputation(&keeper);
    assert_eq!(at_first_boundary.score_bps, 5_000);
    assert_eq!(s.registry.effective_reputation(&keeper), at_first_boundary);

    goto_ledger(&s.env, origin + 2 * half_life - 1);
    assert_eq!(s.registry.effective_reputation(&keeper).score_bps, 5_000);

    goto_ledger(&s.env, origin + 2 * half_life);
    assert_eq!(s.registry.effective_reputation(&keeper).score_bps, 2_500);

    // Read-time decay never changes the persisted history or base score.
    assert_eq!(s.registry.keeper_reputation(&keeper), stored);
}

#[test]
fn effective_reputation_for_untracked_keeper_is_zero_at_any_ledger() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    keep_registry_alive(&s);
    let s = setup_long_lived();
    let keeper = Address::generate(&s.env);
    advance(
        &s.env,
        5 * crate::reputation::REPUTATION_DECAY_HALF_LIFE_LEDGERS,
        0,
    );
    assert_eq!(
        s.registry.effective_reputation(&keeper),
        crate::ReputationRecord::zero()
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim-eligibility floor
// ─────────────────────────────────────────────────────────────────────────────

fn execute_as(s: &TestSetup, keeper: &Address) {
    let task_id = register_default_task(s);
    s.registry.claim_task(keeper, &task_id);
    s.registry
        .execute_task(keeper, &task_id, &Bytes::from_slice(&s.env, b"proof"));
}

/// Claims a task as `keeper` and lets another keeper take it over once the
/// lock lapses, recording one missed claim against `keeper`.
fn miss_as(s: &TestSetup, keeper: &Address) {
    let other = Address::generate(&s.env);
    let (task_id, unlock_at) = claim_with_lock(s, keeper, 120);
    goto_ledger(&s.env, unlock_at);
    s.registry.claim_task(&other, &task_id);
}

/// Two successes and one miss: a stored score of 6_666 bps.
fn keeper_scoring_6666(s: &TestSetup) -> Address {
    let keeper = Address::generate(&s.env);
    execute_as(s, &keeper);
    execute_as(s, &keeper);
    miss_as(s, &keeper);
    assert_eq!(s.registry.keeper_reputation(&keeper).score_bps, 6_666);
    keeper
}

#[test]
fn reputation_floor_defaults_to_disabled_and_admits_untracked_keepers() {
    let s = setup();
    assert_eq!(s.registry.reputation_floor(), 0);

    let newcomer = Address::generate(&s.env);
    let task_id = register_default_task(&s);
    s.registry.claim_task(&newcomer, &task_id);
    assert_eq!(s.registry.get_task(&task_id).claimer, Some(newcomer));
}

#[test]
fn reputation_floor_admits_keeper_at_or_above_it_and_rejects_one_point_below() {
    let s = setup();
    let keeper = keeper_scoring_6666(&s);

    // Floor one point below the keeper's score: the keeper is above it.
    s.registry.set_reputation_floor(&s.admin, &6_665);
    let task_id = register_default_task(&s);
    s.registry.claim_task(&keeper, &task_id);
    assert_eq!(s.registry.get_task(&task_id).claimer, Some(keeper.clone()));

    // Floor exactly at the keeper's score: the comparison is inclusive.
    s.registry.set_reputation_floor(&s.admin, &6_666);
    let task_id = register_default_task(&s);
    s.registry.claim_task(&keeper, &task_id);
    assert_eq!(s.registry.get_task(&task_id).claimer, Some(keeper.clone()));

    // Floor one point above the keeper's score: the keeper is below it.
    s.registry.set_reputation_floor(&s.admin, &6_667);
    let task_id = register_default_task(&s);
    assert_eq!(
        s.registry.try_claim_task(&keeper, &task_id),
        Err(Ok(KeeperError::ReputationBelowFloor))
    );
    assert_eq!(s.registry.get_task(&task_id).claimer, None);
}

#[test]
fn reputation_floor_rejects_untracked_keeper_once_enabled() {
    let s = setup();
    s.registry.set_reputation_floor(&s.admin, &1);

    let newcomer = Address::generate(&s.env);
    let task_id = register_default_task(&s);
    assert_eq!(
        s.registry.try_claim_task(&newcomer, &task_id),
        Err(Ok(KeeperError::ReputationBelowFloor))
    );
}

#[test]
fn reputation_floor_rejection_on_takeover_records_nothing_against_previous_claimer() {
    let s = setup();
    let incumbent = Address::generate(&s.env);
    execute_as(&s, &incumbent);
    let (task_id, unlock_at) = claim_with_lock(&s, &incumbent, 120);
    let incumbent_before = s.registry.keeper_reputation(&incumbent);

    s.registry.set_reputation_floor(&s.admin, &5_000);
    goto_ledger(&s.env, unlock_at);
    let newcomer = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_claim_task(&newcomer, &task_id),
        Err(Ok(KeeperError::ReputationBelowFloor))
    );

    let task = s.registry.get_task(&task_id);
    assert_eq!(task.claimer, Some(incumbent.clone()));
    assert_eq!(s.registry.keeper_reputation(&incumbent), incumbent_before);
}

#[test]
fn reputation_floor_does_not_mask_task_state_errors() {
    let s = setup();
    let holder = Address::generate(&s.env);
    let (task_id, _) = claim_with_lock(&s, &holder, 120);
    s.registry.set_reputation_floor(&s.admin, &10_000);
    let newcomer = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_claim_task(&newcomer, &999),
        Err(Ok(KeeperError::TaskNotFound))
    );
    assert_eq!(
        s.registry.try_claim_task(&newcomer, &task_id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
}

#[test]
fn reputation_floor_compares_stored_score_not_decayed_score() {
    let s = setup_long_lived();
    let keeper = Address::generate(&s.env);
    execute_as(&s, &keeper);
    s.registry.set_reputation_floor(&s.admin, &10_000);

    advance(
        &s.env,
        3 * crate::reputation::REPUTATION_DECAY_HALF_LIFE_LEDGERS,
        0,
    );
    assert_eq!(s.registry.effective_reputation(&keeper).score_bps, 1_250);

    let task_id = register_default_task(&s);
    s.registry.claim_task(&keeper, &task_id);
    assert_eq!(s.registry.get_task(&task_id).claimer, Some(keeper));
}
