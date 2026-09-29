//! Recipient configuration: add / remove / update shares.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use super::common::*;
use crate::TreasuryError;

#[test]
fn test_add_recipient() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &5_000u32);

    let recipients = s.treasury.recipients();
    assert_eq!(recipients.len(), 1);
    assert_eq!(recipients.get(0).unwrap().address, r);
    assert_eq!(recipients.get(0).unwrap().shares_bps, 5_000u32);
    assert_eq!(s.treasury.recipient_shares(&r), 5_000u32);
}

#[test]
fn test_add_recipient_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let r = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_add_recipient(&stranger, &r, &1_000u32),
        Err(Ok(TreasuryError::Unauthorized))
    );
}

#[test]
fn test_add_recipient_rejects_zero_shares() {
    let s = setup();
    let r = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_add_recipient(&s.admin, &r, &0u32),
        Err(Ok(TreasuryError::InvalidShares))
    );
}

#[test]
fn test_add_recipient_rejects_shares_over_max() {
    let s = setup();
    let r = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_add_recipient(&s.admin, &r, &10_001u32),
        Err(Ok(TreasuryError::InvalidShares))
    );
}

#[test]
fn test_add_recipient_rejects_duplicate() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    assert_eq!(
        s.treasury.try_add_recipient(&s.admin, &r, &2_000u32),
        Err(Ok(TreasuryError::RecipientAlreadyExists))
    );
}

#[test]
fn test_add_recipient_rejects_beyond_max_recipients() {
    let s = setup();
    let max = s.treasury.max_recipients();
    for _ in 0..max {
        let r = Address::generate(&s.env);
        s.treasury.add_recipient(&s.admin, &r, &1u32);
    }
    let one_too_many = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_add_recipient(&s.admin, &one_too_many, &1u32),
        Err(Ok(TreasuryError::TooManyRecipients))
    );
}

#[test]
fn test_remove_recipient() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    s.treasury.remove_recipient(&s.admin, &r);

    assert_eq!(s.treasury.recipients().len(), 0);
    assert_eq!(s.treasury.recipient_shares(&r), 0u32);
}

#[test]
fn test_remove_recipient_not_found_fails() {
    let s = setup();
    let r = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_remove_recipient(&s.admin, &r),
        Err(Ok(TreasuryError::RecipientNotFound))
    );
}

#[test]
fn test_remove_recipient_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    assert_eq!(
        s.treasury.try_remove_recipient(&stranger, &r),
        Err(Ok(TreasuryError::Unauthorized))
    );
}

#[test]
fn test_update_recipient_shares() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    s.treasury.update_recipient_shares(&s.admin, &r, &2_500u32);
    assert_eq!(s.treasury.recipient_shares(&r), 2_500u32);
}

#[test]
fn test_update_recipient_shares_not_found_fails() {
    let s = setup();
    let r = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_update_recipient_shares(&s.admin, &r, &1u32),
        Err(Ok(TreasuryError::RecipientNotFound))
    );
}

#[test]
fn test_update_recipient_shares_rejects_invalid() {
    let s = setup();
    let r = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r, &1_000u32);
    assert_eq!(
        s.treasury.try_update_recipient_shares(&s.admin, &r, &0u32),
        Err(Ok(TreasuryError::InvalidShares))
    );
}
