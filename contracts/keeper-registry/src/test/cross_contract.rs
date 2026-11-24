//! Malicious-callee tests and call-site coverage for the external-call review
//! in `docs/CROSS_CONTRACT_CALLS.md` (issue #740).
//!
//! The registry has three external call types — task conditions, verifiers,
//! and the reward token. Each is attacker-influenced (the first two are
//! chosen by the task owner, the last at initialisation), so each gets a test
//! with a deliberately hostile callee. The tests here cover the *re-entry*
//! vector: a callee that calls back into the registry from inside the callback
//! and tries to mutate unrelated state. Panic / reject isolation is covered
//! alongside each call type in `test/condition.rs` and `test/verifier.rs`,
//! and the token's refund-path re-entry in `test/cancel.rs` / `test/expire.rs`.
//!
//! `every_external_call_is_documented` is the mechanical half: it parses every
//! production call site with `include_str!` and fails if one is not named in
//! the review document, so adding a new external call cannot silently bypass
//! this review.

extern crate std;

use std::{collections::BTreeSet, format, string::String};

use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};

use super::common::*;
use crate::{
    mocks::{
        ReentrantToken, ReentrantTokenClient, POINT_BEFORE_BALANCE_UPDATE, TARGET_WITHDRAW_REWARDS,
    },
    KeeperRegistry, KeeperRegistryClient, TaskStatus, TaskType,
};

// ── Hostile callback contracts ─────────────────────────────────────────────

/// A task condition that returns `true` but tries to change the protocol fee
/// from inside `is_met`. Auth is mocked in `setup()`, so the *only* thing that
/// can stop the mutation is the host's reentrancy guard (there is no partial
/// state to guard against — the condition runs before any write).
mod reentering_condition {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

    use crate::KeeperRegistryClient;

    #[contract]
    pub struct ReenteringCondition;

    #[contractimpl]
    impl ReenteringCondition {
        pub fn configure(env: Env, registry: Address, admin: Address) {
            env.storage()
                .instance()
                .set(&symbol_short!("reg"), &registry);
            env.storage().instance().set(&symbol_short!("adm"), &admin);
            env.storage().instance().set(&symbol_short!("ok"), &false);
        }

        pub fn is_met(env: Env, _task_id: u64) -> bool {
            let registry: Address = env.storage().instance().get(&symbol_short!("reg")).unwrap();
            let admin: Address = env.storage().instance().get(&symbol_short!("adm")).unwrap();
            let client = KeeperRegistryClient::new(&env, &registry);
            let succeeded = matches!(client.try_set_fee_bps(&admin, &9_999u32), Ok(Ok(())));
            env.storage()
                .instance()
                .set(&symbol_short!("ok"), &succeeded);
            true
        }

        pub fn reentry_succeeded(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("ok"))
                .unwrap_or(false)
        }
    }
}

/// Same hostile pattern on the verifier side: approve the proof, but from
/// inside `verify` try to rewrite the fee. The registry's own guards all run
/// before this call, so even the host guard is a second line of defence.
mod reentering_verifier {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Bytes, Env};

    use crate::KeeperRegistryClient;

    #[contract]
    pub struct ReenteringVerifier;

    #[contractimpl]
    impl ReenteringVerifier {
        pub fn configure(env: Env, registry: Address, admin: Address) {
            env.storage()
                .instance()
                .set(&symbol_short!("reg"), &registry);
            env.storage().instance().set(&symbol_short!("adm"), &admin);
            env.storage().instance().set(&symbol_short!("ok"), &false);
        }

        pub fn verify(env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            let registry: Address = env.storage().instance().get(&symbol_short!("reg")).unwrap();
            let admin: Address = env.storage().instance().get(&symbol_short!("adm")).unwrap();
            let client = KeeperRegistryClient::new(&env, &registry);
            let succeeded = matches!(client.try_set_fee_bps(&admin, &9_999u32), Ok(Ok(())));
            env.storage()
                .instance()
                .set(&symbol_short!("ok"), &succeeded);
            true
        }

        pub fn reentry_succeeded(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("ok"))
                .unwrap_or(false)
        }
    }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

fn register_task_with(s: &TestSetup, verifier: Option<Address>, condition: Option<Address>) -> u64 {
    let deadline = s.env.ledger().timestamp() + 3_600;
    s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000i128,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &120u32,
        &verifier,
        &condition,
    )
}

// ── Malicious-callee tests ─────────────────────────────────────────────────

#[test]
fn malicious_condition_cannot_mutate_registry_during_claim() {
    let s = setup();
    let original_fee = s.registry.get_fee_bps();

    let condition = s
        .env
        .register(reentering_condition::ReenteringCondition, ());
    let condition_client = reentering_condition::ReenteringConditionClient::new(&s.env, &condition);
    condition_client.configure(&s.registry.address, &s.admin);

    let keeper = Address::generate(&s.env);
    let id = register_task_with(&s, None, Some(condition));

    // The hostile condition still returns true, so the outer claim must
    // proceed normally — the re-entrant mutation attempt must not abort it.
    s.registry.claim_task(&keeper, &id);

    assert!(
        !condition_client.reentry_succeeded(),
        "a condition callback must not be able to change registry config"
    );
    assert_eq!(s.registry.get_fee_bps(), original_fee);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
    assert_eq!(s.registry.get_task(&id).claimer, Some(keeper));

    // Control: the very same admin call succeeds outside a callback, proving
    // the rejection above came from re-entry protection — not from a bad
    // admin address, missing auth, or an invalid fee value.
    s.registry.set_fee_bps(&s.admin, &9_999u32);
    assert_eq!(s.registry.get_fee_bps(), 9_999);
}

#[test]
fn malicious_verifier_cannot_mutate_registry_during_execute() {
    let s = setup();
    let original_fee = s.registry.get_fee_bps();

    let verifier = s.env.register(reentering_verifier::ReenteringVerifier, ());
    let verifier_client = reentering_verifier::ReenteringVerifierClient::new(&s.env, &verifier);
    verifier_client.configure(&s.registry.address, &s.admin);

    let keeper = Address::generate(&s.env);
    let id = register_task_with(&s, Some(verifier), None);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    assert!(
        !verifier_client.reentry_succeeded(),
        "a verifier callback must not be able to change registry config"
    );
    assert_eq!(s.registry.get_fee_bps(), original_fee);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);

    // Control — see the condition test above: the same admin call works
    // outside a callback, so the blocked re-entry was the reentrancy guard.
    s.registry.set_fee_bps(&s.admin, &9_999u32);
    assert_eq!(s.registry.get_fee_bps(), 9_999);
}

#[test]
fn malicious_token_reentry_during_reward_withdrawal_cannot_double_spend() {
    // This test builds its own registry rather than using `setup()` because
    // the reward token must be the hostile `ReentrantToken` mock.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(ReentrantToken, ());
    let token = ReentrantTokenClient::new(&env, &token_id);
    token.mint(&admin, &10_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    let keeper = Address::generate(&env);
    let deadline = env.ledger().timestamp() + 3_600;
    let task_id = registry.register_task(
        &admin,
        &TaskType::Liquidation,
        &calldata(&env),
        &1_000_000i128,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &120u32,
        &None,
        &None,
    );
    registry.claim_task(&keeper, &task_id);
    registry.execute_task(&keeper, &task_id, &Bytes::from_slice(&env, b"proof"));

    let earned = registry.keeper_balance(&keeper);
    assert!(
        earned > 0,
        "the keeper must actually have a reward to steal"
    );

    // Arm the token so the payout transfer tries to re-enter withdraw_rewards
    // before the token's own balance update completes.
    token.arm(
        &registry_id,
        &keeper,
        &TARGET_WITHDRAW_REWARDS,
        &POINT_BEFORE_BALANCE_UPDATE,
        &admin,   // owner arg unused for this target
        &task_id, // task_id arg unused for this target
        &keeper,  // keeper the re-entrant call would target
    );

    registry.withdraw_rewards(&keeper);

    assert!(
        token.reentry_fired(),
        "the hostile transfer must fire the hook"
    );
    assert!(
        !token.reentry_succeeded(),
        "a re-entrant withdrawal must never succeed"
    );
    assert_eq!(registry.keeper_balance(&keeper), 0);
    assert_eq!(
        token.balance(&keeper),
        earned,
        "exactly one payout must have been made"
    );
}

// ── Mechanical call-site coverage ──────────────────────────────────────────

const CALL_SITE_SOURCES: &[(&str, &str)] = &[
    ("task.rs", include_str!("../task.rs")),
    ("admin.rs", include_str!("../admin.rs")),
    ("batch.rs", include_str!("../batch.rs")),
    ("staking.rs", include_str!("../staking.rs")),
    ("views.rs", include_str!("../views.rs")),
];

const REVIEW_DOC: &str = include_str!("../../../../docs/CROSS_CONTRACT_CALLS.md");

/// `file::function` for every production call site matching `pattern`.
/// `pub fn` boundaries in these module-level impl blocks are unambiguous.
fn call_sites(pattern: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for (file, source) in CALL_SITE_SOURCES {
        let mut current_fn = "";
        for line in source.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("pub fn ") {
                current_fn = rest.split('(').next().unwrap_or("").trim();
            }
            if trimmed.contains(pattern) {
                found.insert(format!("{file}::{current_fn}"));
            }
        }
    }
    found
}

#[test]
fn every_external_call_is_documented() {
    let groups: &[(&str, &str)] = &[
        ("condition", "TaskConditionClient::new"),
        ("verifier", "KeeperVerifierClient::new"),
        ("token (reward_token)", "reward_token(&e)?.transfer"),
        ("token (batch)", "token.transfer"),
    ];

    let mut total = 0;
    for (label, pattern) in groups {
        let sites = call_sites(pattern);
        assert!(
            !sites.is_empty(),
            "{label} call pattern not found in source"
        );
        for site in &sites {
            assert!(
                REVIEW_DOC.contains(site),
                "external call site `{site}` ({label}) is missing from \
                 docs/CROSS_CONTRACT_CALLS.md — add a row with its \
                 before/after state and failure handling"
            );
        }
        total += sites.len();
    }

    // Guard against the parser silently finding nothing because a call shape
    // was renamed: the review currently covers these 14 sites.
    assert!(
        total >= 14,
        "expected at least 14 external call sites, parsed {total} — \
         check the source-scan patterns in this test"
    );
}
