//! Instance-storage TTL renewal.

use soroban_sdk::{
    testutils::{Address as _, Deployer as _, Events as _},
    Address,
};

use super::common::*;
use crate::{KeeperError, INSTANCE_BUMP_LEDGERS, INSTANCE_BUMP_THRESHOLD};

// ─────────────────────────────────────────────────────────────────────────────
// Instance TTL renewal
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_instance_ttl_renewed_by_mutation_stays_alive_past_initial_window() {
    let s = setup();

    // initialize() already bumped the instance TTL to ~INSTANCE_BUMP_LEDGERS.
    let ttl_after_init = s
        .env
        .deployer()
        .get_contract_instance_ttl(&s.registry.address);
    assert!(ttl_after_init > INSTANCE_BUMP_THRESHOLD);

    // Advance far enough that remaining TTL drops below the renewal
    // threshold, but not so far that the entry actually expires.
    advance(
        &s.env,
        INSTANCE_BUMP_LEDGERS - INSTANCE_BUMP_THRESHOLD + 1_000,
        0,
    );
    let ttl_before_mutation = s
        .env
        .deployer()
        .get_contract_instance_ttl(&s.registry.address);
    assert!(
        ttl_before_mutation < INSTANCE_BUMP_THRESHOLD,
        "test setup should cross the renewal threshold"
    );

    // A state-mutating admin call renews the TTL back up to
    // ~INSTANCE_BUMP_LEDGERS from the current ledger. Uses an instance-only
    // mutation (no persistent Task entry involved) so this test isolates
    // instance TTL renewal from per-task TTL, which is a separate mechanism
    // covered by `save_task`.
    s.registry.set_min_reward(&s.admin, &0i128);
    let ttl_after_mutation = s
        .env
        .deployer()
        .get_contract_instance_ttl(&s.registry.address);
    assert!(ttl_after_mutation > INSTANCE_BUMP_LEDGERS - 1_000);

    // Advance well past where the *original* TTL window (from initialize)
    // would have expired the instance — total ledgers advanced now exceeds
    // INSTANCE_BUMP_LEDGERS. Without the interim renewal above, the instance
    // would be archived here and every call below would fail.
    advance(&s.env, INSTANCE_BUMP_LEDGERS - 1_000, 0);

    // The contract is still fully usable: reads and further mutations both
    // succeed against the (still-live) instance storage.
    assert_eq!(s.registry.task_count(), 0u64);
    s.registry.set_fee_bps(&s.admin, &500u32);
    assert_eq!(s.registry.get_fee_bps(), 500u32);
}

// Issue 0122: docs/ARCHITECTURE.md's "TTL / archival strategy" section
// explicitly accepts that "a registry that is completely idle ... for the
// full TTL window can still archive" as a tradeoff for not bumping TTL on
// side-effect-free reads. This test proves that failure mode actually
// happens rather than just being documented: with zero mutating calls after
// `initialize()` (the only `bump_instance` call this test ever makes),
// advancing well past `INSTANCE_BUMP_LEDGERS` genuinely lapses the
// instance's TTL. `Deployer::get_contract_instance_ttl`'s host
// implementation computes `live_until_ledger.checked_sub(current_ledger)`,
// which underflows (panics) once the current ledger has actually passed
// the entry's expiry -- so this is a direct proof of archival, not an
// inference.
#[test]
#[should_panic]
fn test_instance_ttl_lapses_when_registry_is_fully_idle_past_bump_window() {
    let s = setup();

    advance(&s.env, INSTANCE_BUMP_LEDGERS + 1_000, 0);

    let _ = s
        .env
        .deployer()
        .get_contract_instance_ttl(&s.registry.address);
}

// Regression test for issue #18: `upgrade` previously emitted no event at
// all, so there was no on-chain, indexable record of who authorised an
// upgrade or which WASM hash it moved to. This asserts the rejection path
// specifically emits nothing — a non-admin's rejected attempt must not
// produce an `Upgraded` event, since `require_admin` fails before
// `emit_upgraded` is ever reached.
//
// The success path (`emit_upgraded` fires with the correct hash before
// `update_current_contract_wasm` swaps the executable) is not covered here
// for the same reason `resource_report` above excludes `upgrade`: exercising
// it for real needs a separately-deployed WASM hash already present on the
// ledger, and `update_current_contract_wasm` only takes effect — success or
// failure — once the whole invocation completes, so a bogus hash can't be
// used to observe the event in isolation without also rolling it back.
#[test]
fn test_upgrade_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let bogus = soroban_sdk::BytesN::from_array(&s.env, &[0u8; 32]);

    assert_eq!(
        s.registry.try_upgrade(&stranger, &bogus),
        Err(Ok(KeeperError::Unauthorized))
    );

    // `events().all()` reflects only the most recent top-level invocation
    // (see the note in `test_withdraw_transfers_balance_and_zeroes_it`), so
    // this is checked immediately after the single `try_upgrade` call above
    // rather than via a before/after count.
    assert!(
        s.env.events().all().is_empty(),
        "a rejected non-admin upgrade must not emit an Upgraded event"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reputation persistent TTL renewal (Issue 0332 / #460)
// ─────────────────────────────────────────────────────────────────────────────

/// Confirms that every write to a keeper's reputation record renews its persistent
/// storage TTL appropriately, ensuring active keepers do not see their reputation
/// records silently archived over time.
#[test]
fn test_reputation_ttl_renewed_by_mutation_stays_alive_past_initial_window() {
    let s = setup();
    let keeper = Address::generate(&s.env);

    // Initial write creates the reputation record in Persistent storage.
    // save_reputation extends persistent TTL to REPUTATION_BUMP_LEDGERS (~100,000 ledgers).
    s.env.as_contract(&s.registry.address, || {
        crate::reputation::record_success(&s.env, &keeper);
    });

    let initial = s.registry.keeper_reputation(&keeper);
    assert_eq!(initial.successful_executions, 1);
    assert_eq!(initial.base_score, 1);

    // Advance far enough that remaining TTL drops below the renewal threshold
    // (100_000 - 50_000 = 50_000 ledgers), but not so far that the entry expires.
    // Advancing 60_000 ledgers leaves ~40_000 ledgers (< REPUTATION_BUMP_THRESHOLD).
    advance(&s.env, 60_000, 300_000);

    // A subsequent mutation updates reputation and triggers extend_ttl back
    // up to REPUTATION_BUMP_LEDGERS (100_000 ledgers) from the current height (60_000).
    s.env.as_contract(&s.registry.address, || {
        crate::reputation::record_success(&s.env, &keeper);
    });

    // Advance well past where the *original* un-renewed window (100_000 ledgers)
    // would have archived the entry — total ledgers advanced is now 120_000.
    advance(&s.env, 60_000, 300_000);

    // Without the interim renewal above, the record would have been evicted at ledger 100_000.
    // Confirm the record is still live, accessible, and retains its accumulated history.
    let renewed = s.registry.keeper_reputation(&keeper);
    assert_eq!(renewed.successful_executions, 2);
    assert_eq!(renewed.base_score, 2);

    // Also confirm the underlying persistent storage key remains present.
    s.env.as_contract(&s.registry.address, || {
        let key = crate::types::DataKey::KeeperReputation(keeper);
        assert!(s.env.storage().persistent().has(&key));
    });
}
