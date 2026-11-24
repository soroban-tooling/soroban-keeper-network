//! Storage-key, TTL and collision survey tests (issue #739).
//!
//! Three kinds of guarantee live here:
//!
//! 1. **Exhaustiveness** — every `DataKey` variant in both contracts, plus the
//!    separate `ReputationKey` enum, has a row in `docs/STORAGE_LAYOUT.md`.
//! 2. **No temporary storage** — a source scan proves no production entry
//!    point uses `e.storage().temporary()`, so the TTL matrix's "instance or
//!    persistent" dichotomy is complete.
//! 3. **Collision + expiry behaviour** — every key of a contract XDR-encodes
//!    to a distinct byte string, and each fund-bearing persistent entry
//!    actually becomes inaccessible when its TTL lapses.

extern crate std;

use std::{format, string::ToString};

use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Deployer as _},
    token,
    xdr::ToXdr,
    Address, Bytes, Env,
};

use super::common::*;
use crate::{
    reputation::ReputationKey, DataKey, KEEPER_BALANCE_BUMP_LEDGERS, KEEPER_BALANCE_BUMP_THRESHOLD,
};

const REGISTRY_TYPES: &str = include_str!("../types.rs");
const REGISTRY_REPUTATION: &str = include_str!("../reputation.rs");
const TREASURY_TYPES: &str = include_str!("../../../treasury/src/types.rs");
const LAYOUT_DOC: &str = include_str!("../../../../docs/STORAGE_LAYOUT.md");

// Every production module of both contracts. A `.temporary()` call added to
// any of them below trips the no-temporary-storage test.
const PRODUCTION_SOURCES: &[&str] = &[
    include_str!("../admin.rs"),
    include_str!("../batch.rs"),
    include_str!("../condition.rs"),
    include_str!("../constants.rs"),
    include_str!("../errors.rs"),
    include_str!("../events.rs"),
    include_str!("../internal.rs"),
    include_str!("../reputation.rs"),
    include_str!("../staking.rs"),
    include_str!("../task.rs"),
    include_str!("../types.rs"),
    include_str!("../verifier.rs"),
    include_str!("../views.rs"),
    include_str!("../../../treasury/src/admin.rs"),
    include_str!("../../../treasury/src/constants.rs"),
    include_str!("../../../treasury/src/distribution.rs"),
    include_str!("../../../treasury/src/errors.rs"),
    include_str!("../../../treasury/src/events.rs"),
    include_str!("../../../treasury/src/internal.rs"),
    include_str!("../../../treasury/src/types.rs"),
    include_str!("../../../treasury/src/views.rs"),
];

// ── Exhaustiveness of the documented key matrix ────────────────────────────

fn enum_variants(
    source: &str,
    enum_header: &str,
) -> std::collections::BTreeSet<std::string::String> {
    let from = source
        .find(enum_header)
        .unwrap_or_else(|| panic!("enum header {enum_header:?} present"))
        + enum_header.len();
    let rest = &source[from..];
    let to = rest.find("\n}").expect("enum closing brace");
    rest[..to]
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("//") && !line.starts_with('#'))
        .map(|line| line.trim_end_matches(',').to_string())
        .collect()
}

fn documented_keys(section: &str) -> std::collections::BTreeSet<std::string::String> {
    section
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("| `")?;
            let name = rest.split('`').next()?;
            (!name.is_empty()).then(|| name.to_string())
        })
        .collect()
}

fn matrix_section(start: &str, end: &str) -> &'static str {
    let from = LAYOUT_DOC.find(start).expect("matrix start marker") + start.len();
    let to = from + LAYOUT_DOC[from..].find(end).expect("matrix end marker");
    &LAYOUT_DOC[from..to]
}

#[test]
fn every_storage_key_has_a_storage_class_and_ttl_row() {
    let expected_registry = enum_variants(REGISTRY_TYPES, "pub enum DataKey {");
    let expected_treasury = enum_variants(TREASURY_TYPES, "pub enum DataKey {");

    // Reputation uses its own enum but shares the registry's storage, so it
    // must appear in the same matrix or the "every entry" claim is false.
    let reputation = enum_variants(REGISTRY_REPUTATION, "pub(crate) enum ReputationKey {");
    assert_eq!(reputation.len(), 1, "one reputation key expected");

    let documented_registry = documented_keys(matrix_section(
        "<!-- BEGIN REGISTRY KEY MATRIX -->",
        "<!-- END REGISTRY KEY MATRIX -->",
    ));
    let documented_treasury = documented_keys(matrix_section(
        "<!-- BEGIN TREASURY KEY MATRIX -->",
        "<!-- END TREASURY KEY MATRIX -->",
    ));

    let mut expected_registry_full = expected_registry.clone();
    for variant in &reputation {
        expected_registry_full.insert(format!("ReputationKey::{variant}"));
    }

    assert_eq!(
        expected_registry_full,
        documented_registry,
        "registry key matrix out of sync — missing: {:?}, stale: {:?}",
        expected_registry_full
            .difference(&documented_registry)
            .collect::<std::vec::Vec<_>>(),
        documented_registry
            .difference(&expected_registry_full)
            .collect::<std::vec::Vec<_>>(),
    );
    assert_eq!(
        expected_treasury,
        documented_treasury,
        "treasury key matrix out of sync — missing: {:?}, stale: {:?}",
        expected_treasury
            .difference(&documented_treasury)
            .collect::<std::vec::Vec<_>>(),
        documented_treasury
            .difference(&expected_treasury)
            .collect::<std::vec::Vec<_>>(),
    );
}

#[test]
fn no_production_code_uses_temporary_storage() {
    for source in PRODUCTION_SOURCES {
        assert!(
            !source.contains(".temporary()"),
            "a production module uses temporary storage; docs/STORAGE_LAYOUT.md \
             only documents instance and persistent TTL policies"
        );
    }
}

// ── Collision proof ────────────────────────────────────────────────────────

#[test]
fn every_registry_key_encodes_to_a_distinct_xdr_value() {
    let env = Env::default();
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    // Every DataKey variant, with payloads chosen so same-typed payloads are
    // equal where possible — that is the case that would collide if the
    // variant discriminant were not part of the encoding.
    let keys: std::vec::Vec<Bytes> = std::vec![
        DataKey::Admin.to_xdr(&env),
        DataKey::FeeBps.to_xdr(&env),
        DataKey::Paused.to_xdr(&env),
        DataKey::TaskCounter.to_xdr(&env),
        DataKey::RewardToken.to_xdr(&env),
        DataKey::Task(1).to_xdr(&env),
        DataKey::KeeperReward(a.clone()).to_xdr(&env),
        DataKey::FeesAccrued.to_xdr(&env),
        DataKey::MinReward.to_xdr(&env),
        DataKey::KeeperStake(a.clone()).to_xdr(&env),
        DataKey::UnbondRequest(a.clone()).to_xdr(&env),
        DataKey::MinStake.to_xdr(&env),
        DataKey::SlashCounter.to_xdr(&env),
        DataKey::Slash(1).to_xdr(&env),
        DataKey::DisputeWindowLedgers.to_xdr(&env),
        DataKey::PendingReward(a.clone()).to_xdr(&env),
        DataKey::SlashHistory(a.clone()).to_xdr(&env),
        DataKey::ReputationFloor.to_xdr(&env),
        // Separate enum, same contract's storage namespace.
        ReputationKey::Keeper(a.clone()).to_xdr(&env),
    ];

    // A different payload under the same variant must also differ.
    assert_ne!(keys[5], DataKey::Task(2).to_xdr(&env));
    assert_ne!(keys[6], DataKey::KeeperReward(b.clone()).to_xdr(&env));

    for i in 0..keys.len() {
        for j in (i + 1)..keys.len() {
            assert_ne!(&keys[i], &keys[j], "storage keys {i} and {j} collide");
        }
    }
}

// ── TTL policy values ──────────────────────────────────────────────────────

fn persistent_ttl(s: &TestSetup, key: &DataKey) -> u32 {
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().persistent().get_ttl(key)
    })
}

/// Keeps the *shared instance* alive for the whole test while a single
/// persistent entry is allowed to lapse. The default 100_000-ledger cap would
/// archive both together and hide which entry caused the failure.
fn keep_instance_alive(s: &TestSetup) {
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().extend_ttl(999_999, 1_000_000)
    });
    assert!(
        s.env
            .deployer()
            .get_contract_instance_ttl(&s.registry.address)
            > 900_000
    );
}

fn advance_past_entry_ttl(s: &TestSetup, key: &DataKey) {
    let ttl = persistent_ttl(s, key);
    keep_instance_alive(s);
    advance(&s.env, ttl + 10, 0);
}

#[test]
fn keeper_balance_entries_get_the_documented_renewal_window() {
    let s = setup();
    let keeper = executed_task_keeper(&s);
    let ttl = persistent_ttl(&s, &DataKey::KeeperReward(keeper));
    assert!(
        ttl > KEEPER_BALANCE_BUMP_THRESHOLD,
        "credit_keeper must renew past the threshold, got {ttl}"
    );
    assert!(ttl <= KEEPER_BALANCE_BUMP_LEDGERS);
}

// ── Expiry-loses-funds behaviour ───────────────────────────────────────────

#[test]
#[should_panic(expected = "archived")]
fn test_expired_task_entry_strands_owner_escrow() {
    let s = setup_with_ttl_cap(1_000_000);
    let id = register_default_task(&s);
    let key = DataKey::Task(id);
    let ttl = persistent_ttl(&s, &key);
    keep_instance_alive(&s);
    // Deadline is untouched (seconds do not advance), so the only reason the
    // permissionless refund cannot run is the archived Task entry itself.
    advance(&s.env, ttl + 10, 0);
    let _ = s.registry.try_expire_task(&id);
}

#[test]
#[should_panic(expected = "archived")]
fn test_expired_keeper_reward_entry_strands_earnings() {
    let s = setup_with_ttl_cap(1_000_000);
    let keeper = executed_task_keeper(&s);
    advance_past_entry_ttl(&s, &DataKey::KeeperReward(keeper.clone()));
    let _ = s.registry.try_withdraw_rewards(&keeper);
}

#[test]
#[should_panic(expected = "archived")]
fn test_expired_keeper_stake_entry_strands_collateral() {
    let s = setup_with_ttl_cap(1_000_000);
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &1_000_000i128);
    s.registry.stake_deposit(&keeper, &500_000i128);
    advance_past_entry_ttl(&s, &DataKey::KeeperStake(keeper.clone()));
    // initiate_unbond reads KeeperStake first; it cannot even start unbonding.
    let _ = s.registry.try_initiate_unbond(&keeper, &1i128);
}

#[test]
#[should_panic(expected = "archived")]
fn test_expired_unbond_request_strands_pending_withdrawal() {
    let s = setup_with_ttl_cap(1_000_000);
    let keeper = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &1_000_000i128);
    s.registry.stake_deposit(&keeper, &500_000i128);
    s.registry.initiate_unbond(&keeper, &500_000i128);
    advance_past_entry_ttl(&s, &DataKey::UnbondRequest(keeper.clone()));
    let _ = s.registry.try_withdraw_stake(&keeper);
}

#[test]
#[should_panic(expected = "archived")]
fn test_expired_pending_reward_entry_strands_credits() {
    let s = setup_with_ttl_cap(1_000_000);
    s.registry.set_dispute_window(&s.admin, &100u32);
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    advance_past_entry_ttl(&s, &DataKey::PendingReward(keeper.clone()));
    // finalize_rewards reads PendingReward before it can credit KeeperReward.
    let _ = s.registry.try_withdraw_rewards(&keeper);
}

#[test]
#[should_panic(expected = "archived")]
fn test_expired_slash_record_forecloses_appeal_refund() {
    let s = setup_with_ttl_cap(1_000_000);
    let keeper = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token_id).mint(&keeper, &1_000i128);
    s.registry.stake_deposit(&keeper, &1_000i128);
    let slash_id = s.registry.slash(
        &s.admin,
        &keeper,
        &500i128,
        &soroban_sdk::symbol_short!("test"),
        &treasury,
    );
    advance_past_entry_ttl(&s, &DataKey::Slash(slash_id));
    // The appeal record is gone: neither raising nor resolving the appeal can
    // return the slashed stake to the keeper.
    let _ = s.registry.try_raise_slash_appeal(&keeper, &slash_id);
}
