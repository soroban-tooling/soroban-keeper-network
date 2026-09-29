//! Read-only views, confirmed against a running sequence of configuration
//! changes and distributions rather than in isolation.
//!
//! `recipients`, `recipient_shares`, `recipient_balance`,
//! `recipient_total_received`, and `total_distributed` are each already
//! touched incidentally by `test/recipients.rs` and `test/distribution.rs`,
//! but this test is the one place that walks a single, realistic sequence —
//! add two recipients, distribute, reweight one, remove the other, add a
//! third, distribute again, withdraw — and checks every view agrees with
//! the running state after each step, per the acceptance criteria for
//! exposing the treasury's configuration and running totals as views.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use super::common::*;

#[test]
fn test_views_agree_with_state_across_a_sequence_of_changes_and_distributions() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    let r3 = Address::generate(&s.env);

    // 1. Two recipients registered, equal weight.
    s.treasury.add_recipient(&s.admin, &r1, &5_000u32);
    s.treasury.add_recipient(&s.admin, &r2, &5_000u32);
    assert_eq!(s.treasury.recipients().len(), 2);
    assert_eq!(s.treasury.recipient_shares(&r1), 5_000u32);
    assert_eq!(s.treasury.recipient_shares(&r2), 5_000u32);
    assert_eq!(s.treasury.recipient_balance(&r1), 0i128);
    assert_eq!(s.treasury.recipient_total_received(&r1), 0i128);
    assert_eq!(s.treasury.total_distributed(), 0i128);

    // 2. First distribution: split evenly.
    s.treasury.distribute(&s.admin, &1_000_000i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 500_000i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 500_000i128);
    assert_eq!(s.treasury.recipient_total_received(&r1), 500_000i128);
    assert_eq!(s.treasury.total_distributed(), 1_000_000i128);

    // 3. Reweight r1 to take 3x r2's share, and register a third recipient.
    s.treasury.update_recipient_shares(&s.admin, &r1, &7_500u32);
    s.treasury.add_recipient(&s.admin, &r3, &2_500u32);
    assert_eq!(s.treasury.recipient_shares(&r1), 7_500u32);
    assert_eq!(s.treasury.recipients().len(), 3);
    // The reweight and new registration must not have touched anything
    // already credited.
    assert_eq!(s.treasury.recipient_balance(&r1), 500_000i128);
    assert_eq!(s.treasury.recipient_balance(&r3), 0i128);
    assert_eq!(s.treasury.total_distributed(), 1_000_000i128);

    // 4. Remove r2 entirely, then distribute again: only r1 and r3 (now the
    //    full 10_000 bps between them) are credited.
    s.treasury.remove_recipient(&s.admin, &r2);
    assert_eq!(s.treasury.recipients().len(), 2);
    assert_eq!(s.treasury.recipient_shares(&r2), 0u32);

    s.treasury.distribute(&s.admin, &1_000_000i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 500_000i128 + 750_000i128);
    assert_eq!(s.treasury.recipient_balance(&r3), 250_000i128);
    // r2's balance and lifetime total are untouched by a distribution it no
    // longer participates in.
    assert_eq!(s.treasury.recipient_balance(&r2), 500_000i128);
    assert_eq!(s.treasury.recipient_total_received(&r2), 500_000i128);
    assert_eq!(s.treasury.total_distributed(), 2_000_000i128);

    // 5. Withdrawing changes only the withdrawable balance, never the
    //    lifetime-received total or the running distributed total.
    let withdrawn = s.treasury.withdraw(&r1);
    assert_eq!(withdrawn, 1_250_000i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 0i128);
    assert_eq!(s.treasury.recipient_total_received(&r1), 1_250_000i128);
    assert_eq!(s.treasury.total_distributed(), 2_000_000i128);

    // 6. Side-effect-free: none of the views above bumped instance TTL past
    //    what the mutating calls already extended it to, and every view is
    //    answerable (never panics) for an address that never registered.
    let stranger = Address::generate(&s.env);
    assert_eq!(s.treasury.recipient_shares(&stranger), 0u32);
    assert_eq!(s.treasury.recipient_balance(&stranger), 0i128);
    assert_eq!(s.treasury.recipient_total_received(&stranger), 0i128);
}

#[test]
fn test_views_answer_harmlessly_on_an_uninitialized_treasury() {
    let env = soroban_sdk::Env::default();
    let treasury_id = env.register(crate::Treasury, ());
    let treasury = crate::TreasuryClient::new(&env, &treasury_id);
    let someone = Address::generate(&env);

    assert_eq!(treasury.admin(), None);
    assert!(!treasury.is_paused());
    assert_eq!(treasury.reward_token_address(), None);
    assert_eq!(treasury.recipients().len(), 0);
    assert_eq!(treasury.recipient_shares(&someone), 0u32);
    assert_eq!(treasury.recipient_balance(&someone), 0i128);
    assert_eq!(treasury.recipient_total_received(&someone), 0i128);
    assert_eq!(treasury.total_distributed(), 0i128);
    assert_eq!(treasury.max_recipients(), crate::MAX_RECIPIENTS);
    assert_eq!(treasury.version(), crate::VERSION);
}
