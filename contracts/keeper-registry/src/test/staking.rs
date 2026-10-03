//! Staking, unbonding, slashing, and the appeal window (epic E06).
//! See `docs/STAKING_DESIGN.md`.

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, Address, Bytes, IntoVal,
};

use super::common::*;
use crate::{KeeperError, MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS, UNBOND_DELAY_LEDGERS};

fn stake(s: &TestSetup, keeper: &Address, amount: i128) {
    let token_client = token::StellarAssetClient::new(&s.env, &s.token_id);
    token_client.mint(keeper, &amount);
    s.registry.stake_deposit(keeper, &amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// stake_deposit
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_stake_deposit_escrows_and_updates_view() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &1_000_000i128);

    assert_eq!(s.registry.keeper_stake(&keeper), 0i128);
    s.registry.stake_deposit(&keeper, &400_000i128);

    assert_eq!(s.registry.keeper_stake(&keeper), 400_000i128);
    assert_eq!(token.balance(&keeper), 600_000i128);
    assert_eq!(token.balance(&s.registry.address), 400_000i128);
}

#[test]
fn test_stake_deposit_accumulates_across_calls() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &1_000_000i128);

    s.registry.stake_deposit(&keeper, &100_000i128);
    s.registry.stake_deposit(&keeper, &50_000i128);

    assert_eq!(s.registry.keeper_stake(&keeper), 150_000i128);
}

#[test]
fn test_stake_deposit_zero_amount_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let result = s.registry.try_stake_deposit(&keeper, &0i128);
    assert_eq!(result, Err(Ok(KeeperError::InvalidReward)));
}

#[test]
fn test_stake_deposit_negative_amount_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let result = s.registry.try_stake_deposit(&keeper, &-1i128);
    assert_eq!(result, Err(Ok(KeeperError::InvalidReward)));
}

#[test]
fn test_stake_deposit_while_paused_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    s.registry.pause(&s.admin);

    let result = s.registry.try_stake_deposit(&keeper, &100_000i128);
    assert_eq!(result, Err(Ok(KeeperError::ContractPaused)));
}

#[test]
fn test_stake_deposit_emits_event() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    stake(&s, &keeper, 250);

    let events = s.env.events().all();
    let (_contract, topics, _data) = events.last().unwrap();
    let expected_topics = (symbol_short!("stkdep"), symbol_short!("stake")).into_val(&s.env);
    assert_eq!(topics, expected_topics);
}

/// #419's own acceptance criterion: staking, executing tasks, and
/// withdrawing rewards are independent operations that never interfere with
/// each other's balances.
#[test]
fn test_staking_is_independent_of_task_rewards() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = executed_task_keeper(&s); // credited 970_000 reward balance
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &1_000_000i128);

    s.registry.stake_deposit(&keeper, &200_000i128);

    // Reward balance untouched by staking.
    assert_eq!(s.registry.keeper_balance(&keeper), 970_000i128);
    assert_eq!(s.registry.keeper_stake(&keeper), 200_000i128);

    let withdrawn = s.registry.withdraw_rewards(&keeper);
    assert_eq!(withdrawn, 970_000i128);
    // Withdrawing rewards leaves stake untouched.
    assert_eq!(s.registry.keeper_stake(&keeper), 200_000i128);
    assert_eq!(token.balance(&keeper), 970_000i128 + 800_000i128); // reward + unstaked remainder
}

// ─────────────────────────────────────────────────────────────────────────────
// initiate_unbond / withdraw_stake
// ─────────────────────────────────────────────────────────────────────────────

fn staked_keeper(s: &TestSetup, amount: i128) -> Address {
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &(amount * 2));
    s.registry.stake_deposit(&keeper, &amount);
    keeper
}

#[test]
fn test_initiate_unbond_reduces_effective_stake_immediately() {
    let s = setup();
    let keeper = staked_keeper(&s, 500_000);

    s.registry.initiate_unbond(&keeper, &200_000i128);

    // The unbonding amount leaves the effective (claim-gating) stake right
    // away, well before the unbonding delay elapses.
    assert_eq!(s.registry.keeper_stake(&keeper), 300_000i128);

    let pending = s.registry.pending_unbond(&keeper).unwrap();
    assert_eq!(pending.amount, 200_000i128);
}

#[test]
fn test_initiate_unbond_exceeding_stake_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 100_000);

    let result = s.registry.try_initiate_unbond(&keeper, &200_000i128);
    assert_eq!(result, Err(Ok(KeeperError::InsufficientStake)));
}

#[test]
fn test_initiate_unbond_zero_amount_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 100_000);
    let result = s.registry.try_initiate_unbond(&keeper, &0i128);
    assert_eq!(result, Err(Ok(KeeperError::InvalidReward)));
}

#[test]
fn test_initiate_unbond_while_one_already_pending_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 500_000);

    s.registry.initiate_unbond(&keeper, &100_000i128);

    let result = s.registry.try_initiate_unbond(&keeper, &50_000i128);
    assert_eq!(result, Err(Ok(KeeperError::UnbondAlreadyPending)));
}

#[test]
fn test_withdraw_stake_before_delay_elapses_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 500_000);
    s.registry.initiate_unbond(&keeper, &200_000i128);

    advance(&s.env, UNBOND_DELAY_LEDGERS - 1, 0);

    let result = s.registry.try_withdraw_stake(&keeper);
    assert_eq!(result, Err(Ok(KeeperError::UnbondNotReady)));
}

#[test]
fn test_withdraw_stake_at_exact_boundary_succeeds() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = staked_keeper(&s, 500_000);
    s.registry.initiate_unbond(&keeper, &200_000i128);

    advance(&s.env, UNBOND_DELAY_LEDGERS, 0);

    let withdrawn = s.registry.withdraw_stake(&keeper);
    assert_eq!(withdrawn, 200_000i128);
    assert_eq!(token.balance(&keeper), 200_000i128 + 500_000i128); // withdrawn + unstaked remainder
    assert!(s.registry.pending_unbond(&keeper).is_none());
}

#[test]
fn test_withdraw_stake_with_no_pending_request_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 500_000);

    let result = s.registry.try_withdraw_stake(&keeper);
    assert_eq!(result, Err(Ok(KeeperError::NoPendingUnbond)));
}

// ─────────────────────────────────────────────────────────────────────────────
// slash
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_slash_reduces_stake_and_pays_treasury() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);

    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    assert_eq!(s.registry.keeper_stake(&keeper), 800);
    assert_eq!(token.balance(&treasury), 200);
    assert!(s.registry.get_slash(&slash_id).is_some());
}

#[test]
fn test_slash_exceeding_stake_and_pending_unbond_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);

    let result = s.registry.try_slash(
        &s.admin,
        &keeper,
        &2_000,
        &symbol_short!("fraud"),
        &treasury,
    );
    assert_eq!(result, Err(Ok(KeeperError::InsufficientStake)));
}

/// Security-review finding (docs/STAKING_SECURITY_REVIEW.md): unbonding must
/// not let a keeper evade a slash by front-running it with `initiate_unbond`.
/// Slashable exposure is `KeeperStake` plus anything sitting in a pending
/// `UnbondRequest`, not `KeeperStake` alone.
#[test]
fn test_slash_can_draw_from_pending_unbond_amount() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);

    s.registry.initiate_unbond(&keeper, &800i128);
    // Effective (fully-bonded) stake is now only 200.
    assert_eq!(s.registry.keeper_stake(&keeper), 200);

    // A 500 slash cannot be covered by KeeperStake (200) alone, but is
    // covered once the pending unbond (800) is also counted.
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &500, &symbol_short!("fraud"), &treasury);
    assert!(s.registry.get_slash(&slash_id).is_some());
    assert_eq!(s.registry.keeper_stake(&keeper), 0);

    let pending = s.registry.pending_unbond(&keeper).unwrap();
    assert_eq!(pending.amount, 500);
}

#[test]
fn test_slash_by_non_admin_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let not_admin = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);

    let result = s.registry.try_slash(
        &not_admin,
        &keeper,
        &200,
        &symbol_short!("fraud"),
        &treasury,
    );
    assert_eq!(result, Err(Ok(KeeperError::Unauthorized)));
}

#[test]
fn test_slash_history_tracks_count_and_total() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);

    assert_eq!(s.registry.slash_history(&keeper), (0u32, 0i128));

    s.registry
        .slash(&s.admin, &keeper, &100, &symbol_short!("fraud"), &treasury);
    s.registry
        .slash(&s.admin, &keeper, &50, &symbol_short!("late"), &treasury);

    assert_eq!(s.registry.slash_history(&keeper), (2u32, 150i128));
}

// ─────────────────────────────────────────────────────────────────────────────
// set_min_stake / claim_task gating (issue #420)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_min_stake_defaults_to_zero_and_does_not_gate_claiming() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let task_id = register_default_task(&s);

    assert_eq!(s.registry.min_stake(), 0i128);
    // No stake at all, yet claiming succeeds because the floor is disabled.
    s.registry.claim_task(&keeper, &task_id);
}

#[test]
fn test_set_min_stake_by_non_admin_fails() {
    let s = setup();
    let not_admin = Address::generate(&s.env);

    let result = s.registry.try_set_min_stake(&not_admin, &500i128);
    assert_eq!(result, Err(Ok(KeeperError::Unauthorized)));
}

#[test]
fn test_set_min_stake_negative_fails() {
    let s = setup();
    let result = s.registry.try_set_min_stake(&s.admin, &-1i128);
    assert_eq!(result, Err(Ok(KeeperError::InvalidReward)));
}

/// #420's own acceptance criterion: a keeper exactly at the floor, one ledger
/// of unbonding below it, and one action above it.
#[test]
fn test_claim_task_at_exactly_the_min_stake_floor_succeeds() {
    let s = setup();
    s.registry.set_min_stake(&s.admin, &500_000i128);
    let keeper = staked_keeper(&s, 500_000i128);
    let task_id = register_default_task(&s);

    // Exactly at the floor must be sufficient — not just above it.
    s.registry.claim_task(&keeper, &task_id);
}

#[test]
fn test_claim_task_below_the_min_stake_floor_fails() {
    let s = setup();
    s.registry.set_min_stake(&s.admin, &500_000i128);
    let keeper = staked_keeper(&s, 499_999i128);
    let task_id = register_default_task(&s);

    let result = s.registry.try_claim_task(&keeper, &task_id);
    assert_eq!(result, Err(Ok(KeeperError::MinStakeNotMet)));
}

/// A keeper whose bonded stake alone still meets the floor, but has
/// initiated an unbond that would (if counted) drop it below the floor, is
/// still gated on the reduced *effective* stake — `keeper_stake` already
/// excludes anything mid-unbond, and `claim_task` reads the same value.
#[test]
fn test_claim_task_rejects_stake_that_is_mid_unbond() {
    let s = setup();
    s.registry.set_min_stake(&s.admin, &500_000i128);
    let keeper = staked_keeper(&s, 600_000i128);
    s.registry.initiate_unbond(&keeper, &200_000i128);
    // Effective stake is now 400_000, one increment below the 500_000 floor.
    assert_eq!(s.registry.keeper_stake(&keeper), 400_000i128);

    let task_id = register_default_task(&s);
    let result = s.registry.try_claim_task(&keeper, &task_id);
    assert_eq!(result, Err(Ok(KeeperError::MinStakeNotMet)));
}

#[test]
fn test_claim_task_above_the_min_stake_floor_succeeds() {
    let s = setup();
    s.registry.set_min_stake(&s.admin, &500_000i128);
    let keeper = staked_keeper(&s, 500_001i128);
    let task_id = register_default_task(&s);

    s.registry.claim_task(&keeper, &task_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// raise_slash_appeal / resolve_slash_appeal
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_raise_slash_appeal_by_non_slashed_keeper_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let not_keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    let result = s.registry.try_raise_slash_appeal(&not_keeper, &slash_id);
    assert_eq!(result, Err(Ok(KeeperError::NotSlashedKeeper)));
}

#[test]
fn test_raise_slash_appeal_twice_fails() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    s.registry.raise_slash_appeal(&keeper, &slash_id);

    assert_eq!(
        s.registry.try_raise_slash_appeal(&keeper, &slash_id),
        Err(Ok(KeeperError::AppealAlreadyRaised))
    );
}

#[test]
fn test_raise_slash_appeal_boundary_after_window_is_rejected() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    advance(&s.env, crate::DISPUTE_WINDOW_LEDGERS + 1, 0);

    assert_eq!(
        s.registry.try_raise_slash_appeal(&keeper, &slash_id),
        Err(Ok(KeeperError::AppealWindowClosed))
    );
}

#[test]
fn test_raise_slash_appeal_boundary_exactly_at_window_succeeds() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    advance(&s.env, crate::DISPUTE_WINDOW_LEDGERS, 0);

    s.registry.raise_slash_appeal(&keeper, &slash_id);
    assert!(s.registry.get_slash(&slash_id).unwrap().appealed);
}

#[test]
fn test_resolve_slash_appeal_upheld_refunds_and_restores_stake() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);
    s.registry.raise_slash_appeal(&keeper, &slash_id);

    // The admin must fund the refund itself (the contract no longer holds
    // the slashed amount — see docs/STAKING_DESIGN.md §4.1).
    let token_client = token::StellarAssetClient::new(&s.env, &s.token_id);
    token_client.mint(&s.admin, &200);

    s.registry.resolve_slash_appeal(&s.admin, &slash_id, &true);

    assert_eq!(s.registry.keeper_stake(&keeper), 1_000);
    // The record is removed once resolved.
    assert_eq!(s.registry.get_slash(&slash_id), None);
}

#[test]
fn test_resolve_slash_appeal_rejected_leaves_slash_standing() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);
    s.registry.raise_slash_appeal(&keeper, &slash_id);

    s.registry.resolve_slash_appeal(&s.admin, &slash_id, &false);

    // No refund: stake stays at what it was after the slash.
    assert_eq!(s.registry.keeper_stake(&keeper), 800);
    assert_eq!(s.registry.get_slash(&slash_id), None);
}

#[test]
fn test_resolve_slash_appeal_rejects_unauthorized_caller() {
    let s = setup();
    let keeper = staked_keeper(&s, 1_000);
    let not_admin = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);
    s.registry.raise_slash_appeal(&keeper, &slash_id);

    let result = s
        .registry
        .try_resolve_slash_appeal(&not_admin, &slash_id, &true);
    assert_eq!(result, Err(Ok(KeeperError::Unauthorized)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution dispute window (docs/STAKING_DESIGN.md §4.2)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_dispute_window_defaults_to_zero_credits_finalize_immediately() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    assert_eq!(s.registry.dispute_window(), 0u32);
    let withdrawn = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn > 0);
}

#[test]
fn test_set_dispute_window_above_ceiling_fails() {
    let s = setup();
    assert_eq!(
        s.registry
            .try_set_dispute_window(&s.admin, &(MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS + 1)),
        Err(Ok(KeeperError::InvalidTaskParams))
    );
}

#[test]
fn test_set_dispute_window_accepts_exactly_the_ceiling() {
    let s = setup();

    s.registry
        .set_dispute_window(&s.admin, &MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS);
    assert_eq!(
        s.registry.dispute_window(),
        MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS
    );
}

#[test]
fn test_dispute_execution_by_non_owner_fails() {
    let s = setup();
    s.registry.set_dispute_window(&s.admin, &1_000);
    let keeper = Address::generate(&s.env);
    let not_owner = Address::generate(&s.env);

    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let result = s.registry.try_dispute_execution(&not_owner, &id);
    assert_eq!(result, Err(Ok(KeeperError::NotTaskOwner)));
}

#[test]
fn test_dispute_execution_after_window_closes_fails() {
    let s = setup();
    s.registry.set_dispute_window(&s.admin, &1_000);
    let keeper = Address::generate(&s.env);

    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    advance(&s.env, 1_001, 0);

    let result = s.registry.try_dispute_execution(&s.admin, &id);
    assert_eq!(result, Err(Ok(KeeperError::DisputeWindowClosed)));
}

#[test]
fn test_resolve_execution_dispute_upheld_forfeits_reward_to_fees() {
    let s = setup();
    s.registry.set_dispute_window(&s.admin, &1_000);
    let keeper = Address::generate(&s.env);

    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    s.registry.dispute_execution(&s.admin, &id);

    let fees_before = s.registry.fees_accrued();
    s.registry.resolve_execution_dispute(&s.admin, &id, &true);

    // The keeper is never paid: nothing left to withdraw for this task.
    assert_eq!(s.registry.pending_reward(&keeper).len(), 0);
    assert_eq!(s.registry.keeper_balance(&keeper), 0);
    assert!(s.registry.fees_accrued() > fees_before);
}

#[test]
fn test_resolve_execution_dispute_rejected_keeper_still_gets_paid() {
    let s = setup();
    s.registry.set_dispute_window(&s.admin, &1_000);
    let keeper = Address::generate(&s.env);

    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    s.registry.dispute_execution(&s.admin, &id);
    s.registry.resolve_execution_dispute(&s.admin, &id, &false);

    // Cleared dispute, past its unlock_ledger already (dispute_window elapsed
    // during resolution's own ledger advance in this simplified test — force
    // it explicitly so finalization is unambiguous).
    advance(&s.env, 1_000, 0);
    let withdrawn = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn > 0);
}

#[test]
fn test_multiple_pending_credits_finalize_independently() {
    let s = setup();
    s.registry.set_dispute_window(&s.admin, &1_000);
    let keeper = Address::generate(&s.env);

    let id1 = register_default_task(&s);
    s.registry.claim_task(&keeper, &id1);
    s.registry
        .execute_task(&keeper, &id1, &Bytes::from_slice(&s.env, b"p1"));

    advance(&s.env, 500, 0);

    let id2 = register_default_task(&s);
    s.registry.claim_task(&keeper, &id2);
    s.registry
        .execute_task(&keeper, &id2, &Bytes::from_slice(&s.env, b"p2"));

    assert_eq!(s.registry.pending_reward(&keeper).len(), 2);

    // First credit's window has elapsed; second's has not.
    advance(&s.env, 500, 0);
    let withdrawn_first = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn_first > 0);
    assert_eq!(s.registry.pending_reward(&keeper).len(), 1);

    // Second credit's window elapses too.
    advance(&s.env, 500, 0);
    let withdrawn_second = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn_second > 0);
    assert_eq!(s.registry.pending_reward(&keeper).len(), 0);
}
