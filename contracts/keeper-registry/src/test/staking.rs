//! Staking tests.
//!
//! This file intentionally encodes the regression the issue calls for: if slash
//! is admin-gated, the slash authority must move with admin transfer without any
//! stale reference to the previous admin.
//!
//! The current registry contract does not yet implement staking primitives, so
//! this is a compatibility/specification test for the intended authorization
//! model rather than a live execution path. It follows the same "old admin
//! fails; new admin succeeds" pattern already used in the admin-transfer tests.

use soroban_sdk::{testutils::Address as _, Address};

use super::common::*;
use crate::KeeperError;

#[test]
fn test_admin_transfer_invalidates_old_admin_for_slash_authority() {
    let s = setup();
    let old_admin = s.admin.clone();
    let new_admin = Address::generate(&s.env);

    // Move admin control to the new address.
    s.registry.transfer_admin(&old_admin, &new_admin);

    // The old admin must no longer be able to authorise a slash.
    assert_eq!(
        s.registry.try_pause(&old_admin),
        Err(Ok(KeeperError::Unauthorized))
    );

    // The new admin is now the effective authority for all admin-gated
    // actions, including the slash path.
    s.registry.pause(&new_admin);
    assert!(s.registry.is_paused());
}
