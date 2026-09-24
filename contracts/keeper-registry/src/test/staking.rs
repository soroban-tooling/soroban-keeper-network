//! Staking, unbonding, slashing, and the appeal window (epic E06).
//! See `docs/STAKING_DESIGN.md`.

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, Address, Bytes, IntoVal, TryIntoVal,
};

use super::common::*;
use crate::{DataKey, KeeperError, UNBOND_DELAY_LEDGERS};

fn stake(s: &TestSetup, keeper: &Address, amount: i128) {
    let token_client = token::StellarAssetClient::new(&s.env, &s.token_id);
    token_client.mint(keeper, &amount);
    s.registry.stake_deposit(keeper, &amount);
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
