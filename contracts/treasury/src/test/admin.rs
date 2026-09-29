//! Admin controls: pause / transfer_admin / upgrade.
//!
//! Mirrors `contracts/keeper-registry/src/test/admin.rs` and
//! `contracts/keeper-registry/src/test/ttl.rs` for the equivalent entry
//! points.

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::Address;

use super::common::*;
use crate::TreasuryError;

#[test]
fn test_pause_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.treasury.try_pause(&stranger),
        Err(Ok(TreasuryError::Unauthorized))
    );
}

#[test]
fn test_pause_emits_event() {
    let s = setup();
    s.treasury.pause(&s.admin);
    assert!(!s.env.events().all().is_empty());
}

#[test]
fn test_unpause_restores_distribute() {
    let s = setup();
    let r1 = Address::generate(&s.env);
    s.treasury.add_recipient(&s.admin, &r1, &1u32);

    s.treasury.pause(&s.admin);
    s.treasury.unpause(&s.admin);
    assert!(!s.treasury.is_paused());

    s.treasury.distribute(&s.admin, &1_000i128);
    assert_eq!(s.treasury.recipient_balance(&r1), 1_000i128);
}

#[test]
fn test_transfer_admin_moves_control() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.treasury.transfer_admin(&s.admin, &new_admin);
    assert_eq!(s.treasury.admin(), Some(new_admin.clone()));

    assert_eq!(
        s.treasury.try_pause(&s.admin),
        Err(Ok(TreasuryError::Unauthorized))
    );
    s.treasury.pause(&new_admin);
    assert!(s.treasury.is_paused());
}

#[test]
fn test_transfer_admin_emits_event() {
    let s = setup();
    let old_admin = s.admin.clone();
    let new_admin = Address::generate(&s.env);
    s.treasury.transfer_admin(&old_admin, &new_admin);

    let found = s.env.events().all().iter().any(|event| {
        use soroban_sdk::TryIntoVal;
        event.2.try_into_val(&s.env) == Ok((old_admin.clone(), new_admin.clone()))
    });
    assert!(found, "AdminTransferred event was not emitted");
}

// ─────────────────────────────────────────────────────────────────────────────
// upgrade
//
// The registry's own upgrade tests (`contracts/keeper-registry/src/test/
// ttl.rs`) document why a real `update_current_contract_wasm` swap cannot be
// exercised from this crate's native test harness: it needs a
// separately-deployed WASM hash already installed on the ledger, and this
// workspace has no wasm32 build step wired into `cargo test`. The same
// limitation applies here, so this suite covers exactly what the registry's
// does: the admin gate, and that a rejected call emits nothing. A real
// storage-survives-a-wasm-swap test needs the same wasm32 toolchain / build
// step the registry test suite is also missing it, tracked as a shared gap
// rather than solved ad hoc per contract.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_upgrade_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let bogus = soroban_sdk::BytesN::from_array(&s.env, &[0u8; 32]);

    assert_eq!(
        s.treasury.try_upgrade(&stranger, &bogus),
        Err(Ok(TreasuryError::Unauthorized))
    );
    assert!(
        s.env.events().all().is_empty(),
        "a rejected non-admin upgrade must not emit an Upgraded event"
    );
}

#[test]
fn test_upgrade_before_init_fails() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let id = env.register(crate::Treasury, ());
    let client = crate::TreasuryClient::new(&env, &id);
    let stranger = Address::generate(&env);
    let bogus = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);

    assert_eq!(
        client.try_upgrade(&stranger, &bogus),
        Err(Ok(TreasuryError::NotInitialized))
    );
}
