//! `distribute` / `withdraw`.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address};

use super::common::*;
use crate::TreasuryError;

#[test]
fn test_distribute_splits_pro_rata() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &3_000u32); // 30%
    s.treasury.add_recipient(&s.admin, &r2, &7_000u32); // 70%

    s.treasury.distribute(&s.admin, &1_000_000i128);

    assert_eq!(s.treasury.recipient_balance(&r1), 300_000i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 700_000i128);
    assert_eq!(s.treasury.total_distributed(), 1_000_000i128);
}

#[test]
fn test_distribute_shares_need_not_sum_to_ten_thousand() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    // Equal weight, regardless of the raw bps values chosen.
    s.treasury.add_recipient(&s.admin, &r1, &1u32);
    s.treasury.add_recipient(&s.admin, &r2, &1u32);

    s.treasury.distribute(&s.admin, &1_000_000i128);

    assert_eq!(s.treasury.recipient_balance(&r1), 500_000i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 500_000i128);
}

#[test]
fn test_distribute_only_pulls_what_it_credits() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);

    let token = token::Client::new(&s.env, &s.token_id);
    let admin_before = token.balance(&s.admin);

    // 3 stroops split across shares summing to 1 recipient's full share still
    // credits the full amount (single recipient gets 100%).
    s.treasury.distribute(&s.admin, &3i128);
    assert_eq!(token.balance(&s.admin), admin_before - 3i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 3i128);
}

#[test]
fn test_distribute_rejects_non_positive_amount() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);
    assert_eq!(
        s.treasury.try_distribute(&s.admin, &0i128),
        Err(Ok(TreasuryError::InvalidAmount))
    );
    assert_eq!(
        s.treasury.try_distribute(&s.admin, &-1i128),
        Err(Ok(TreasuryError::InvalidAmount))
    );
}

#[test]
fn test_distribute_with_no_recipients_fails() {
    let s = setup();
    assert_eq!(
        s.treasury.try_distribute(&s.admin, &1_000i128),
        Err(Ok(TreasuryError::NoRecipients))
    );
}

#[test]
fn test_distribute_ignores_removed_recipients() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1_000u32);
    s.treasury.add_recipient(&s.admin, &r2, &1_000u32);
    s.treasury.remove_recipient(&s.admin, &r1);

    s.treasury.distribute(&s.admin, &1_000_000i128);

    assert_eq!(s.treasury.recipient_balance(&r1), 0i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 1_000_000i128);
}

#[test]
fn test_distribute_is_blocked_while_paused() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);
    s.treasury.pause(&s.admin);

    assert_eq!(
        s.treasury.try_distribute(&s.admin, &1_000i128),
        Err(Ok(TreasuryError::ContractPaused))
    );
    assert_eq!(s.treasury.recipient_balance(&r1), 0i128);
}

#[test]
fn test_withdraw_transfers_and_zeroes_balance() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);
    s.treasury.distribute(&s.admin, &1_000_000i128);

    let token = token::Client::new(&s.env, &s.token_id);
    assert_eq!(token.balance(&r1), 0i128);

    let withdrawn = s.treasury.withdraw(&r1);
    assert_eq!(withdrawn, 1_000_000i128);
    assert_eq!(token.balance(&r1), 1_000_000i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 0i128);
    // Lifetime total is untouched by a withdrawal.
    assert_eq!(s.treasury.recipient_total_received(&r1), 1_000_000i128);
}

#[test]
fn test_withdraw_with_zero_balance_fails() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_withdraw(&r1),
        Err(Ok(TreasuryError::NoRewardsAvailable))
    );
}

#[test]
fn test_withdraw_allowed_while_paused() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);
    s.treasury.distribute(&s.admin, &1_000_000i128);
    s.treasury.pause(&s.admin);

    let withdrawn = s.treasury.withdraw(&r1);
    assert_eq!(withdrawn, 1_000_000i128);
}

#[test]
fn test_distribute_emits_event_per_recipient() {
    use soroban_sdk::testutils::Events as _;

    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);
    s.treasury.add_recipient(&s.admin, &r2, &1u32);

    s.treasury.distribute(&s.admin, &1_000_000i128);

    // One `Distributed` event per credited recipient, at minimum.
    assert!(s.env.events().all().len() >= 2);
}
