//! Instance-storage TTL renewal.

use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Deployer as _, Events as _},
    token, Address,
};

use super::common::*;
use crate::{
    DataKey, KeeperError, INSTANCE_BUMP_LEDGERS, INSTANCE_BUMP_THRESHOLD,
    KEEPER_BALANCE_BUMP_LEDGERS, KEEPER_BALANCE_BUMP_THRESHOLD,
};

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

// Issue #440: every new staking entry point (epic E06) must call
// bump_instance and extend the TTL of any persistent-scoped stake entry it
// touches, from its first version — mirroring credit_keeper's pattern for
// KeeperReward, and the same test shape issue 0015's original regression
// test (above) used for instance TTL. This proves it for the persistent
// KeeperStake entry specifically: without stake_deposit's extend_ttl call,
// the entry would archive during the first advance below, and reading it
// back via `initiate_unbond` (which calls `keeper_stake_of`) would panic on
// an archived-entry access rather than returning a typed error.
#[test]
fn test_keeper_stake_ttl_renewed_by_staking_action_stays_alive_past_initial_window() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let stake_token = token::StellarAssetClient::new(&s.env, &s.token_id);
    stake_token.mint(&keeper, &1_000_000i128);

    s.registry.stake_deposit(&keeper, &500_000i128);
    let stake_key = DataKey::KeeperStake(keeper.clone());

    let ttl_after_deposit = s.env.as_contract(&s.registry.address, || {
        s.env.storage().persistent().get_ttl(&stake_key)
    });
    assert!(ttl_after_deposit > KEEPER_BALANCE_BUMP_THRESHOLD);

    // Advance far enough that the entry's remaining TTL drops below its own
    // renewal threshold, but not so far that it would have archived from
    // this deposit's renewal alone.
    advance(
        &s.env,
        KEEPER_BALANCE_BUMP_LEDGERS - KEEPER_BALANCE_BUMP_THRESHOLD + 1_000,
        0,
    );
    let ttl_before_mutation = s.env.as_contract(&s.registry.address, || {
        s.env.storage().persistent().get_ttl(&stake_key)
    });
    assert!(
        ttl_before_mutation < KEEPER_BALANCE_BUMP_THRESHOLD,
        "test setup should cross the renewal threshold"
    );

    // A staking action that touches this same key renews its TTL back up to
    // ~KEEPER_BALANCE_BUMP_LEDGERS from the current ledger.
    s.registry.initiate_unbond(&keeper, &100_000i128);
    let ttl_after_mutation = s.env.as_contract(&s.registry.address, || {
        s.env.storage().persistent().get_ttl(&stake_key)
    });
    assert!(ttl_after_mutation > KEEPER_BALANCE_BUMP_LEDGERS - 1_000);

    // Advance well past where the *original* TTL window (from the initial
    // deposit) would have archived the entry — total ledgers advanced now
    // exceeds KEEPER_BALANCE_BUMP_LEDGERS. Without the interim renewal
    // above, `keeper_stake` below would panic on an archived-entry read.
    advance(&s.env, KEEPER_BALANCE_BUMP_LEDGERS - 1_000, 0);

    // The contract remains fully usable: the stake entry is still readable
    // (proving it didn't archive), and admin actions against the registry
    // still succeed. Deliberately avoids a further token-moving call here
    // (stake_deposit/withdraw_stake) — the separately-deployed token
    // contract's own instance TTL is a different concern with no renewal
    // mechanism this test (or the code under test) controls, and is not
    // what this regression test is pinning.
    assert_eq!(s.registry.keeper_stake(&keeper), 400_000i128);
    s.registry.set_min_stake(&s.admin, &0i128);
    assert_eq!(s.registry.min_stake(), 0i128);
}

// Security review finding (docs/STAKING_SECURITY_REVIEW.md, "Appeal never
// renews TTL"): raise_slash_appeal is a state-mutating entry point that
// previously called neither bump_instance nor extend_ttl on the Slash record
// it updates. A slash's original TTL bump (from `slash` itself) only lasts
// KEEPER_BALANCE_BUMP_LEDGERS from the slash, and there is no deadline on
// how long an admin may take to call resolve_slash_appeal once an appeal is
// raised — so a real appeal, raised well within the dispute window, could
// still have its resolution blocked by the whole instance archiving before
// the admin acts, with nothing about the appeal itself keeping the contract
// alive in the interim.
#[test]
fn test_raise_slash_appeal_renews_ttl_so_resolution_survives_a_slow_admin() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    let stake_token = token::StellarAssetClient::new(&s.env, &s.token_id);
    stake_token.mint(&keeper, &1_000i128);
    s.registry.stake_deposit(&keeper, &1_000i128);

    let slash_id = s.registry.slash(
        &s.admin,
        &keeper,
        &500i128,
        &soroban_sdk::symbol_short!("test"),
        &treasury,
    );

    // Appeal raised near the end of the (~3-day, 51_840-ledger) dispute
    // window, but critically *after* the instance TTL from `slash`'s own
    // bump_instance call has already dropped below INSTANCE_BUMP_THRESHOLD
    // (50_000) — `extend_ttl` is a documented no-op above that threshold
    // (see test_instance_ttl_renewed_by_mutation_stays_alive_past_initial_
    // window above), so raising the appeal any earlier than this wouldn't
    // actually exercise raise_slash_appeal's own renewal at all.
    advance(&s.env, 50_500, 0);
    s.registry.raise_slash_appeal(&keeper, &slash_id);

    // The admin is slow: advance well past where the *original* slash-time
    // TTL bump would have archived the registry and the Slash record
    // (ledger 100_000), with no other contract activity in between. Without
    // raise_slash_appeal's own renewal (from ledger 50_500, extending both
    // to ~150_500), the registry itself and the Slash record lookup below
    // would panic on an archived-entry access at this point.
    //
    // Rejects (uphold_appeal: false) rather than upholds, deliberately: an
    // upheld appeal's refund path separately reads and writes KeeperStake,
    // whose own TTL is governed by docs/ARCHITECTURE.md's documented,
    // accepted "known asymmetric case" (a persistent balance entry not
    // touched by its own subsequent activity can independently archive,
    // same as KeeperReward) — a different, already-accepted tradeoff this
    // test isn't about. Rejecting exercises the record-removal path this
    // fix is actually pinning without also depending on that separate
    // entry's liveness.
    advance(&s.env, 60_000, 0); // now at ledger 110_500

    let result = s
        .registry
        .try_resolve_slash_appeal(&s.admin, &slash_id, &false);
    assert!(
        result.is_ok(),
        "expected resolve_slash_appeal to succeed: {:?}",
        result
    );
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
