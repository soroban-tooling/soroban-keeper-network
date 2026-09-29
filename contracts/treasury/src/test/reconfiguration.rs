//! Recipient reconfiguration after deployment: set re-validation and the
//! exact effect of a mid-flight change on balances that were already
//! credited (see the "Mid-flight configuration changes" note in `admin.rs`).

use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address};

use super::common::*;
use crate::{DataKey, TreasuryError, MAX_SHARES_BPS, MAX_TOTAL_SHARES};

/// Simulates storage drift (e.g. a partial migration) that leaves a
/// registered recipient with a zero share.
fn drift_shares_to_zero(s: &TestSetup, recipient: &Address) {
    s.env.as_contract(&s.treasury.address, || {
        s.env
            .storage()
            .persistent()
            .set(&DataKey::RecipientShares(recipient.clone()), &0u32);
    });
}

fn token(s: &TestSetup) -> token::Client<'static> {
    token::Client::new(&s.env, &s.token_id)
}

/// Every token the treasury holds is owed to exactly one recipient.
fn assert_conserved(s: &TestSetup, recipients: &[&Address]) {
    let owed: i128 = recipients
        .iter()
        .map(|r| s.treasury.recipient_balance(r))
        .sum();
    assert_eq!(token(s).balance(&s.treasury.address), owed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-validation of the whole set after each change
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_set_at_max_total_shares_is_accepted() {
    let s = setup();
    for _ in 0..s.treasury.max_recipients() {
        let r = Address::generate(&s.env);
        s.treasury.add_recipient(&s.admin, &r, &MAX_SHARES_BPS);
    }
    let total: u32 = s.treasury.recipients().iter().map(|r| r.shares_bps).sum();
    assert_eq!(total, MAX_TOTAL_SHARES);

    // The largest valid set still distributes without overflow.
    s.treasury.distribute(&s.admin, &1_000_000i128);
    assert_eq!(s.treasury.total_distributed(), 1_000_000i128);
}

#[test]
fn test_add_recipient_revalidates_existing_set() {
    let s = setup();
    let healthy = Address::generate(&s.env);
    let drifted = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &healthy, &1_000u32);
    s.treasury.add_recipient(&s.admin, &drifted, &1_000u32);
    drift_shares_to_zero(&s, &drifted);

    let newcomer = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_add_recipient(&s.admin, &newcomer, &1_000u32),
        Err(Ok(TreasuryError::InvalidShares))
    );
    // The rejected change is rolled back in full.
    assert_eq!(s.treasury.recipients().len(), 2);
    assert_eq!(s.treasury.recipient_shares(&newcomer), 0u32);
}

#[test]
fn test_update_recipient_shares_revalidates_existing_set() {
    let s = setup();
    let healthy = Address::generate(&s.env);
    let drifted = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &healthy, &1_000u32);
    s.treasury.add_recipient(&s.admin, &drifted, &1_000u32);
    drift_shares_to_zero(&s, &drifted);

    assert_eq!(
        s.treasury
            .try_update_recipient_shares(&s.admin, &healthy, &2_000u32),
        Err(Ok(TreasuryError::InvalidShares))
    );
    assert_eq!(s.treasury.recipient_shares(&healthy), 1_000u32);
}

#[test]
fn test_remove_recipient_revalidates_remaining_set() {
    let s = setup();
    let leaving = Address::generate(&s.env);
    let drifted = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &leaving, &1_000u32);
    s.treasury.add_recipient(&s.admin, &drifted, &1_000u32);
    drift_shares_to_zero(&s, &drifted);

    assert_eq!(
        s.treasury.try_remove_recipient(&s.admin, &leaving),
        Err(Ok(TreasuryError::InvalidShares))
    );
    assert_eq!(s.treasury.recipients().len(), 2);
    assert_eq!(s.treasury.recipient_shares(&leaving), 1_000u32);

    // Removing the drifted recipient itself restores a valid set.
    s.treasury.remove_recipient(&s.admin, &drifted);
    assert_eq!(s.treasury.recipients().len(), 1);
}

#[test]
fn test_update_recipient_shares_renews_share_entry_ttl() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);

    // Let the share entry drop below the renewal threshold.
    s.env.ledger().with_mut(|li| li.sequence_number += 60_000);
    let key = DataKey::RecipientShares(r.clone());
    let before = s.env.as_contract(&s.treasury.address, || {
        s.env.storage().persistent().get_ttl(&key)
    });

    s.treasury.update_recipient_shares(&s.admin, &r, &2_000u32);
    let after = s.env.as_contract(&s.treasury.address, || {
        s.env.storage().persistent().get_ttl(&key)
    });
    assert!(
        after > before,
        "reweighting must renew the share entry's TTL"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mid-flight changes never lose or misroute credited funds
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_removed_recipient_keeps_and_can_withdraw_credited_balance() {
    let s = setup();
    let staying = Address::generate(&s.env);
    let leaving = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &staying, &5_000u32);
    s.treasury.add_recipient(&s.admin, &leaving, &5_000u32);
    s.treasury.distribute(&s.admin, &1_000i128);

    s.treasury.remove_recipient(&s.admin, &leaving);
    assert_eq!(s.treasury.recipient_balance(&leaving), 500i128);
    assert_conserved(&s, &[&staying, &leaving]);

    // Future distributions go entirely to the remaining recipient.
    s.treasury.distribute(&s.admin, &1_000i128);
    assert_eq!(s.treasury.recipient_balance(&staying), 1_500i128);
    assert_eq!(s.treasury.recipient_balance(&leaving), 500i128);
    assert_conserved(&s, &[&staying, &leaving]);

    // The removed recipient can still pull exactly what it earned.
    assert_eq!(s.treasury.withdraw(&leaving), 500i128);
    assert_eq!(token(&s).balance(&leaving), 500i128);
    assert_conserved(&s, &[&staying, &leaving]);
}

#[test]
fn test_reweight_applies_only_to_future_distributions() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &5_000u32);
    s.treasury.add_recipient(&s.admin, &r2, &5_000u32);
    s.treasury.distribute(&s.admin, &1_000i128);

    s.treasury.update_recipient_shares(&s.admin, &r1, &1_000u32);
    s.treasury.update_recipient_shares(&s.admin, &r2, &9_000u32);
    // Already-credited balances are not recomputed.
    assert_eq!(s.treasury.recipient_balance(&r1), 500i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 500i128);

    s.treasury.distribute(&s.admin, &1_000i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 600i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 1_400i128);
    assert_conserved(&s, &[&r1, &r2]);
}

#[test]
fn test_readded_recipient_accrues_on_top_of_prior_balance() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &5_000u32);
    s.treasury.add_recipient(&s.admin, &r2, &5_000u32);
    s.treasury.distribute(&s.admin, &1_000i128);

    s.treasury.remove_recipient(&s.admin, &r2);
    s.treasury.add_recipient(&s.admin, &r2, &5_000u32);
    s.treasury.distribute(&s.admin, &1_000i128);

    assert_eq!(s.treasury.recipient_balance(&r2), 1_000i128);
    assert_eq!(s.treasury.recipient_total_received(&r2), 1_000i128);
    assert_conserved(&s, &[&r1, &r2]);
}

#[test]
fn test_removing_last_recipient_blocks_distribution_without_moving_funds() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    s.treasury.distribute(&s.admin, &1_000i128);
    s.treasury.remove_recipient(&s.admin, &r);

    let admin_before = token(&s).balance(&s.admin);
    assert_eq!(
        s.treasury.try_distribute(&s.admin, &1_000i128),
        Err(Ok(TreasuryError::NoRecipients))
    );
    assert_eq!(token(&s).balance(&s.admin), admin_before);
    assert_eq!(s.treasury.recipient_balance(&r), 1_000i128);
    assert_conserved(&s, &[&r]);
}

#[test]
fn test_direct_transfer_is_unaffected_by_configuration_changes() {
    // Tokens sent to the treasury outside `distribute` belong to no
    // recipient; reconfiguring never assigns them to one.
    let s = setup();
    let r1 = Address::generate(&s.env);
    let r2 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &5_000u32);
    token(&s).transfer(&s.admin, &s.treasury.address, &777i128);

    s.treasury.add_recipient(&s.admin, &r2, &5_000u32);
    s.treasury.update_recipient_shares(&s.admin, &r1, &2_000u32);
    s.treasury.remove_recipient(&s.admin, &r1);

    assert_eq!(s.treasury.recipient_balance(&r1), 0i128);
    assert_eq!(s.treasury.recipient_balance(&r2), 0i128);
    assert_eq!(token(&s).balance(&s.treasury.address), 777i128);
}
