//! Staking, unbonding, slashing, and the appeal window (epic E06).
//! See `docs/STAKING_DESIGN.md`.

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, Address, Bytes, IntoVal, TryIntoVal,
};

use super::common::*;
use crate::{DataKey, KeeperError, MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS, UNBOND_DELAY_LEDGERS};

fn stake(s: &TestSetup, keeper: &Address, amount: i128) {
    let token_client = token::StellarAssetClient::new(&s.env, &s.token_id);
    token_client.mint(keeper, &amount);
    s.registry.stake_deposit(keeper, &amount);
}

/// Registers, claims, and executes a task, with the dispute window already
/// set to `window_ledgers`. Returns `(task_id, keeper)`. The task owner is
/// always `s.admin`, matching `register_default_task`/`register_reward_task`'s
/// existing convention, so `s.admin` is the right caller for
/// `dispute_execution` in these tests.
fn executed_task_with_dispute_window(s: &TestSetup, window_ledgers: u32) -> (u64, Address) {
    s.registry.set_dispute_window(&s.admin, &window_ledgers);
    let keeper = Address::generate(&s.env);
    let id = register_default_task(s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    (id, keeper)
}

// ─────────────────────────────────────────────────────────────────────────────
// stake_deposit (issue 0289)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_stake_deposit_credits_keeper_stake_view() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    stake(&s, &keeper, 500);

    assert_eq!(s.registry.keeper_stake(&keeper), 500);
}

#[test]
fn test_stake_deposit_accumulates_across_multiple_calls() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    stake(&s, &keeper, 500);
    stake(&s, &keeper, 300);

    assert_eq!(s.registry.keeper_stake(&keeper), 800);
}

#[test]
fn test_stake_deposit_rejects_non_positive_amount() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_stake_deposit(&keeper, &0),
        Err(Ok(KeeperError::InvalidReward))
    );
    assert_eq!(
        s.registry.try_stake_deposit(&keeper, &-1),
        Err(Ok(KeeperError::InvalidReward))
    );
}

// Stake is stored under its own DataKey variant, never conflated with
// KeeperReward — this is issue 0289's explicit acceptance criterion.
#[test]
fn test_staking_executing_and_withdrawing_rewards_are_independent() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    stake(&s, &keeper, 1_000);

    // Runs the reward flow for the SAME keeper that staked, so the two
    // balances genuinely share an address and independence is actually
    // exercised, not just true because they happen to belong to different
    // addresses.
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    let reward_balance = s.registry.keeper_balance(&keeper);
    assert!(
        reward_balance > 0,
        "execute_task should have credited a reward"
    );

    // Staking is untouched by the reward credit.
    assert_eq!(s.registry.keeper_stake(&keeper), 1_000);

    // Withdrawing the reward does not touch stake.
    s.registry.withdraw_rewards(&keeper);
    assert_eq!(s.registry.keeper_stake(&keeper), 1_000);
    assert_eq!(s.registry.keeper_balance(&keeper), 0);
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

// ─────────────────────────────────────────────────────────────────────────────
// initiate_unbond / withdraw_stake boundary (issue 0290)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_initiate_unbond_reduces_effective_stake_immediately() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);

    s.registry.initiate_unbond(&keeper, &400);

    assert_eq!(s.registry.keeper_stake(&keeper), 600);
}

#[test]
fn test_initiate_unbond_rejects_amount_over_current_stake() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 100);

    assert_eq!(
        s.registry.try_initiate_unbond(&keeper, &101),
        Err(Ok(KeeperError::InsufficientStake))
    );
}

#[test]
fn test_initiate_unbond_rejects_a_second_pending_request() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);

    s.registry.initiate_unbond(&keeper, &100);

    assert_eq!(
        s.registry.try_initiate_unbond(&keeper, &100),
        Err(Ok(KeeperError::UnbondAlreadyPending))
    );
}

#[test]
fn test_withdraw_stake_boundary_delay_minus_one_is_not_ready() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &400);

    advance(&s.env, UNBOND_DELAY_LEDGERS - 1, 0);

    assert_eq!(
        s.registry.try_withdraw_stake(&keeper),
        Err(Ok(KeeperError::UnbondNotReady))
    );
}

#[test]
fn test_withdraw_stake_boundary_exactly_at_delay_is_ready() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &400);

    advance(&s.env, UNBOND_DELAY_LEDGERS, 0);

    let withdrawn = s.registry.withdraw_stake(&keeper);
    assert_eq!(withdrawn, 400);
}

#[test]
fn test_withdraw_stake_boundary_delay_plus_one_is_ready() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &400);

    advance(&s.env, UNBOND_DELAY_LEDGERS + 1, 0);

    let withdrawn = s.registry.withdraw_stake(&keeper);
    assert_eq!(withdrawn, 400);
}

#[test]
fn test_withdraw_stake_transfers_tokens_and_clears_the_request() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &400);
    advance(&s.env, UNBOND_DELAY_LEDGERS, 0);

    let token = token::Client::new(&s.env, &s.token_id);
    let balance_before = token.balance(&keeper);

    s.registry.withdraw_stake(&keeper);

    assert_eq!(token.balance(&keeper), balance_before + 400);
    // The request is cleared: a second withdraw finds nothing pending.
    assert_eq!(
        s.registry.try_withdraw_stake(&keeper),
        Err(Ok(KeeperError::NoPendingUnbond))
    );
}

#[test]
fn test_withdraw_stake_with_no_request_is_rejected() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_withdraw_stake(&keeper),
        Err(Ok(KeeperError::NoPendingUnbond))
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// slash and its authorization model (issue 0291)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_slash_moves_funds_to_treasury_and_reduces_stake() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);

    let token = token::Client::new(&s.env, &s.token_id);
    let treasury_before = token.balance(&treasury);

    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &300, &symbol_short!("fraud"), &treasury);

    assert_eq!(s.registry.keeper_stake(&keeper), 700);
    assert_eq!(token.balance(&treasury), treasury_before + 300);
    assert_eq!(slash_id, 1);
}

#[test]
fn test_slash_rejects_unauthorized_caller() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let not_admin = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);

    assert_eq!(
        s.registry.try_slash(
            &not_admin,
            &keeper,
            &100,
            &symbol_short!("fraud"),
            &treasury
        ),
        Err(Ok(KeeperError::Unauthorized))
    );
}

#[test]
fn test_slash_never_exceeds_current_stake() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 500);

    assert_eq!(
        s.registry
            .try_slash(&s.admin, &keeper, &501, &symbol_short!("fraud"), &treasury),
        Err(Ok(KeeperError::InsufficientStake))
    );
}

// Security review finding (docs/STAKING_SECURITY_REVIEW.md, "Unbonding as a
// slash-evasion path"): before the fix, initiate_unbond removed funds from
// KeeperStake immediately (well before UNBOND_DELAY_LEDGERS elapses), and
// slash only ever looked at KeeperStake — so a keeper could unbond their
// entire stake the moment they suspected a slash was coming and leave slash
// with nothing to act on, even though the funds were still fully within the
// contract's custody and nowhere near withdrawable yet. This is the exact
// regression test for that gap: slash must still succeed by drawing on the
// pending unbond amount.
#[test]
fn test_slash_draws_on_pending_unbond_when_keeper_stake_is_insufficient() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);

    // Keeper unbonds everything, leaving KeeperStake at 0.
    s.registry.initiate_unbond(&keeper, &1_000);
    assert_eq!(s.registry.keeper_stake(&keeper), 0);

    let token = token::Client::new(&s.env, &s.token_id);
    let treasury_before = token.balance(&treasury);

    // The admin's slash still succeeds, drawing from the pending unbond.
    let slash_id = s.registry.slash(
        &s.admin,
        &keeper,
        &600,
        &symbol_short!("evasion"),
        &treasury,
    );
    assert_eq!(slash_id, 1);
    assert_eq!(token.balance(&treasury), treasury_before + 600);

    // The unbond request survives, reduced by exactly the slashed amount;
    // its unlock_ledger is unaffected.
    let remaining_unbond = s.registry.pending_unbond(&keeper).unwrap();
    assert_eq!(remaining_unbond.amount, 400);
}

#[test]
fn test_slash_fully_consumes_and_removes_pending_unbond() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &1_000);

    s.registry.slash(
        &s.admin,
        &keeper,
        &1_000,
        &symbol_short!("evasion"),
        &treasury,
    );

    // Fully consumed: the unbond request is gone, not left at amount = 0.
    assert!(s.registry.pending_unbond(&keeper).is_none());

    // And it is genuinely gone, not just reported as such: a subsequent
    // withdraw_stake call (which would succeed against a live-but-empty
    // request) correctly fails with NoPendingUnbond instead.
    advance(&s.env, UNBOND_DELAY_LEDGERS, 0);
    assert_eq!(
        s.registry.try_withdraw_stake(&keeper),
        Err(Ok(KeeperError::NoPendingUnbond))
    );
}

#[test]
fn test_slash_draws_from_keeper_stake_before_pending_unbond() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &300); // stake: 700, unbond: 300

    // A slash that KeeperStake alone can cover must not touch the pending
    // unbond at all.
    s.registry
        .slash(&s.admin, &keeper, &500, &symbol_short!("fraud"), &treasury);

    assert_eq!(s.registry.keeper_stake(&keeper), 200);
    let unbond = s.registry.pending_unbond(&keeper).unwrap();
    assert_eq!(
        unbond.amount, 300,
        "an unrelated pending unbond must be untouched"
    );
}

#[test]
fn test_slash_still_rejects_amount_exceeding_stake_plus_pending_unbond() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    s.registry.initiate_unbond(&keeper, &1_000); // total exposure: 1_000

    assert_eq!(
        s.registry.try_slash(
            &s.admin,
            &keeper,
            &1_001,
            &symbol_short!("fraud"),
            &treasury
        ),
        Err(Ok(KeeperError::InsufficientStake))
    );
    // Rejected atomically: neither KeeperStake nor the pending unbond changed.
    assert_eq!(s.registry.keeper_stake(&keeper), 0);
    assert_eq!(s.registry.pending_unbond(&keeper).unwrap().amount, 1_000);
}

#[test]
fn test_slash_emits_event_with_reconstructable_reason() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);

    let reason = symbol_short!("badproof");
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &reason, &treasury);

    let events = s.env.events().all();
    let (_contract, topics, data) = events.last().unwrap();
    let expected_topics = (symbol_short!("slash"), symbol_short!("stake")).into_val(&s.env);
    assert_eq!(topics, expected_topics);

    let (event_id, event_keeper, event_amount, event_reason): (
        u64,
        Address,
        i128,
        soroban_sdk::Symbol,
    ) = data.try_into_val(&s.env).unwrap();
    assert_eq!(event_id, slash_id);
    assert_eq!(event_keeper, keeper);
    assert_eq!(event_amount, 200);
    assert_eq!(event_reason, reason);
}

// ─────────────────────────────────────────────────────────────────────────────
// set_min_stake and claim_task enforcement (issue 0292)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_claim_task_succeeds_with_no_min_stake_configured() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    // No stake at all, and no MinStake configured — must still succeed.
    s.registry.claim_task(&keeper, &id);
    assert_eq!(s.registry.get_task(&id).claimer, Some(keeper));
}

#[test]
fn test_claim_task_boundary_exactly_at_min_stake_succeeds() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    s.registry.set_min_stake(&s.admin, &1_000);
    stake(&s, &keeper, 1_000);

    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    assert_eq!(s.registry.get_task(&id).claimer, Some(keeper));
}

#[test]
fn test_claim_task_boundary_one_below_min_stake_is_rejected() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    s.registry.set_min_stake(&s.admin, &1_000);
    stake(&s, &keeper, 999);

    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::MinStakeNotMet))
    );
}

#[test]
fn test_claim_task_boundary_one_above_min_stake_succeeds() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    s.registry.set_min_stake(&s.admin, &1_000);
    stake(&s, &keeper, 1_001);

    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    assert_eq!(s.registry.get_task(&id).claimer, Some(keeper));
}

#[test]
fn test_claim_task_min_stake_excludes_stake_mid_unbond() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    s.registry.set_min_stake(&s.admin, &1_000);
    stake(&s, &keeper, 1_000);
    // Unbonding even a small amount drops effective stake below the floor.
    s.registry.initiate_unbond(&keeper, &1);

    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::MinStakeNotMet))
    );
}

#[test]
fn test_set_min_stake_rejects_unauthorized_caller() {
    let s = setup();
    let not_admin = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_set_min_stake(&not_admin, &1_000),
        Err(Ok(KeeperError::Unauthorized))
    );
}

#[test]
fn test_set_min_stake_rejects_negative_value() {
    let s = setup();

    assert_eq!(
        s.registry.try_set_min_stake(&s.admin, &-1),
        Err(Ok(KeeperError::InvalidReward))
    );
}

// Issue 0309 / #437's own acceptance criterion: "A min_stake view exists,
// mirroring min_reward's existing shape and defaults-to-zero-if-unset
// behavior" and "a test confirms the view reflects an admin update to the
// configured minimum."
#[test]
fn test_min_stake_view_defaults_to_zero() {
    let s = setup();

    assert_eq!(s.registry.min_stake(), 0);
}

#[test]
fn test_min_stake_view_reflects_admin_update() {
    let s = setup();

    s.registry.set_min_stake(&s.admin, &2_500);
    assert_eq!(s.registry.min_stake(), 2_500);

    s.registry.set_min_stake(&s.admin, &500);
    assert_eq!(s.registry.min_stake(), 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash appeal (issue 0302 / #430)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_raise_slash_appeal_by_slashed_keeper_succeeds() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    s.registry.raise_slash_appeal(&keeper, &slash_id);

    assert!(s.registry.get_slash(&slash_id).unwrap().appealed);
}

#[test]
fn test_raise_slash_appeal_rejects_a_non_slashed_caller() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let other = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    assert_eq!(
        s.registry.try_raise_slash_appeal(&other, &slash_id),
        Err(Ok(KeeperError::NotSlashedKeeper))
    );
}

#[test]
fn test_raise_slash_appeal_rejects_unknown_slash_id() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_raise_slash_appeal(&keeper, &999),
        Err(Ok(KeeperError::SlashNotFound))
    );
}

#[test]
fn test_raise_slash_appeal_rejects_a_second_appeal() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
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
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
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
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
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
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
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
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
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
    let keeper = Address::generate(&s.env);
    let not_admin = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);
    s.registry.raise_slash_appeal(&keeper, &slash_id);

    assert_eq!(
        s.registry
            .try_resolve_slash_appeal(&not_admin, &slash_id, &true),
        Err(Ok(KeeperError::Unauthorized))
    );
}

#[test]
fn test_resolve_slash_appeal_rejects_a_never_appealed_slash() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);

    // No raise_slash_appeal call.
    assert_eq!(
        s.registry
            .try_resolve_slash_appeal(&s.admin, &slash_id, &true),
        Err(Ok(KeeperError::SlashNotFound))
    );
}

#[test]
fn test_resolve_slash_appeal_cannot_be_called_twice() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    stake(&s, &keeper, 1_000);
    let slash_id = s
        .registry
        .slash(&s.admin, &keeper, &200, &symbol_short!("fraud"), &treasury);
    s.registry.raise_slash_appeal(&keeper, &slash_id);
    s.registry.resolve_slash_appeal(&s.admin, &slash_id, &false);

    assert_eq!(
        s.registry
            .try_resolve_slash_appeal(&s.admin, &slash_id, &false),
        Err(Ok(KeeperError::SlashNotFound))
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage-key isolation smoke test (issue 0289's own words: "never
// conflated with KeeperReward")
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_keeper_stake_and_keeper_reward_are_distinct_storage_keys() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    stake(&s, &keeper, 777);

    // Direct storage inspection: DataKey::KeeperStake and
    // DataKey::KeeperReward for the same address must be independently
    // readable/absent.
    let has_reward = s.env.as_contract(&s.registry.address, || {
        s.env
            .storage()
            .persistent()
            .has(&DataKey::KeeperReward(keeper.clone()))
    });
    assert!(
        !has_reward,
        "staking alone must not create a KeeperReward entry"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution dispute window (issue 0293 / #421)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_dispute_window_disabled_by_default_credit_is_immediately_withdrawable() {
    let s = setup();
    // No set_dispute_window call: default must be 0 (disabled).
    assert_eq!(s.registry.dispute_window(), 0);

    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    // Immediately withdrawable — the unmodified wave-1 MVP behavior.
    assert!(s.registry.keeper_balance(&keeper) > 0);
    let withdrawn = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn > 0);
    assert_eq!(s.registry.pending_reward(&keeper).len(), 0);
}

#[test]
fn test_dispute_window_enabled_holds_credit_as_pending() {
    let s = setup();
    let (id, keeper) = executed_task_with_dispute_window(&s, 1_000);

    // Not yet in KeeperReward.
    assert_eq!(s.registry.keeper_balance(&keeper), 0);
    let pending = s.registry.pending_reward(&keeper);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending.get(0).unwrap().task_id, id);
    assert!(!pending.get(0).unwrap().disputed);

    // Withdrawing too early finds nothing finalized yet.
    assert_eq!(
        s.registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );
}

#[test]
fn test_dispute_window_boundary_finalizes_exactly_at_unlock_ledger() {
    let s = setup();
    let (_, keeper) = executed_task_with_dispute_window(&s, 1_000);

    advance(&s.env, 999, 0);
    assert_eq!(
        s.registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );

    advance(&s.env, 1, 0);
    let withdrawn = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn > 0);
    assert_eq!(s.registry.pending_reward(&keeper).len(), 0);
}

#[test]
fn test_dispute_execution_by_task_owner_marks_credit_disputed() {
    let s = setup();
    let (id, keeper) = executed_task_with_dispute_window(&s, 1_000);

    s.registry.dispute_execution(&s.admin, &id);

    let pending = s.registry.pending_reward(&keeper);
    assert_eq!(pending.len(), 1);
    assert!(pending.get(0).unwrap().disputed);
}

#[test]
fn test_dispute_execution_rejects_non_owner() {
    let s = setup();
    let (id, _keeper) = executed_task_with_dispute_window(&s, 1_000);
    let not_owner = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_dispute_execution(&not_owner, &id),
        Err(Ok(KeeperError::NotTaskOwner))
    );
}

#[test]
fn test_dispute_execution_rejects_after_window_closed() {
    let s = setup();
    let (id, _keeper) = executed_task_with_dispute_window(&s, 1_000);

    advance(&s.env, 1_001, 0);

    assert_eq!(
        s.registry.try_dispute_execution(&s.admin, &id),
        Err(Ok(KeeperError::DisputeWindowClosed))
    );
}

// Security review finding (docs/STAKING_SECURITY_REVIEW.md, "Dispute-window
// boundary mismatch"): this test used to assert the opposite — that a
// dispute at exactly unlock_ledger was still accepted, explicitly relying on
// dispute_execution "winning the race" against finalize_rewards' `>=`
// finalization boundary at that same ledger. That was a real,
// transaction-ordering-dependent race, not a deterministic rule. The fix
// closes the dispute window at the same boundary finalization opens at
// (both now `>=`), so the outcome at exactly unlock_ledger no longer depends
// on which call happens to land first.
#[test]
fn test_dispute_execution_boundary_exactly_at_unlock_ledger_is_too_late() {
    let s = setup();
    let (id, _keeper) = executed_task_with_dispute_window(&s, 1_000);

    advance(&s.env, 1_000, 0);

    assert_eq!(
        s.registry.try_dispute_execution(&s.admin, &id),
        Err(Ok(KeeperError::DisputeWindowClosed))
    );
}

#[test]
fn test_dispute_execution_boundary_one_ledger_before_unlock_is_still_allowed() {
    let s = setup();
    let (id, keeper) = executed_task_with_dispute_window(&s, 1_000);

    advance(&s.env, 999, 0);

    s.registry.dispute_execution(&s.admin, &id);
    assert!(s.registry.pending_reward(&keeper).get(0).unwrap().disputed);
}

#[test]
fn test_dispute_execution_rejects_a_second_dispute() {
    let s = setup();
    let (id, _keeper) = executed_task_with_dispute_window(&s, 1_000);
    s.registry.dispute_execution(&s.admin, &id);

    assert_eq!(
        s.registry.try_dispute_execution(&s.admin, &id),
        Err(Ok(KeeperError::ExecutionAlreadyDisputed))
    );
}

#[test]
fn test_dispute_execution_rejects_unexecuted_task() {
    let s = setup();
    s.registry.set_dispute_window(&s.admin, &1_000);
    let id = register_default_task(&s);
    // Never claimed or executed — no claimer, so no pending credit.

    assert_eq!(
        s.registry.try_dispute_execution(&s.admin, &id),
        Err(Ok(KeeperError::NoPendingCredit))
    );
}

#[test]
fn test_dispute_execution_emits_event() {
    let s = setup();
    let (id, keeper) = executed_task_with_dispute_window(&s, 1_000);

    s.registry.dispute_execution(&s.admin, &id);

    let events = s.env.events().all();
    let (_contract, topics, data) = events.last().unwrap();
    let expected_topics = (symbol_short!("exdisp"), symbol_short!("task")).into_val(&s.env);
    assert_eq!(topics, expected_topics);
    let (event_task_id, event_keeper): (u64, Address) = data.try_into_val(&s.env).unwrap();
    assert_eq!(event_task_id, id);
    assert_eq!(event_keeper, keeper);
}

#[test]
fn test_resolve_execution_dispute_upheld_never_pays_the_reward() {
    let s = setup();
    let (id, keeper) = executed_task_with_dispute_window(&s, 1_000);
    s.registry.dispute_execution(&s.admin, &id);

    s.registry.resolve_execution_dispute(&s.admin, &id, &true);

    assert_eq!(s.registry.pending_reward(&keeper).len(), 0);
    advance(&s.env, 1_000, 0);
    assert_eq!(
        s.registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );
}

#[test]
fn test_resolve_execution_dispute_rejected_finalizes_normally() {
    let s = setup();
    let (id, keeper) = executed_task_with_dispute_window(&s, 1_000);
    s.registry.dispute_execution(&s.admin, &id);

    s.registry.resolve_execution_dispute(&s.admin, &id, &false);

    // The credit is no longer disputed; once its unlock_ledger passes it
    // finalizes and pays out exactly as if it had never been disputed.
    advance(&s.env, 1_000, 0);
    let withdrawn = s.registry.withdraw_rewards(&keeper);
    assert!(withdrawn > 0);
}

#[test]
fn test_resolve_execution_dispute_rejects_unauthorized_caller() {
    let s = setup();
    let (id, _keeper) = executed_task_with_dispute_window(&s, 1_000);
    s.registry.dispute_execution(&s.admin, &id);
    let not_admin = Address::generate(&s.env);

    assert_eq!(
        s.registry
            .try_resolve_execution_dispute(&not_admin, &id, &true),
        Err(Ok(KeeperError::Unauthorized))
    );
}

#[test]
fn test_resolve_execution_dispute_rejects_a_never_disputed_credit() {
    let s = setup();
    let (id, _keeper) = executed_task_with_dispute_window(&s, 1_000);
    // No dispute_execution call.

    assert_eq!(
        s.registry
            .try_resolve_execution_dispute(&s.admin, &id, &true),
        Err(Ok(KeeperError::NoDisputedCredit))
    );
}

#[test]
fn test_set_dispute_window_rejects_unauthorized_caller() {
    let s = setup();
    let not_admin = Address::generate(&s.env);

    assert_eq!(
        s.registry.try_set_dispute_window(&not_admin, &1_000),
        Err(Ok(KeeperError::Unauthorized))
    );
}

#[test]
fn test_set_dispute_window_rejects_above_the_ceiling() {
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
