//! `update_verifier` tests, plus `execute_task`'s interaction with an
//! attached `IKeeperVerifier` — epic E04's verifier-gated path
//! (`docs/VERIFIER_DESIGN.md`).
//!
//! Three minimal test-only verifier contracts follow the `mod reentrant_token
//! { ... }` local-mock-contract pattern already established in
//! `cancel.rs`/`expire.rs`: one that always approves, one that always
//! rejects (backing issue #105's `VerificationFailed`/`TaskVerificationFailed`
//! acceptance criteria), and one that always panics (the proof-of-behavior
//! test for the panic-isolation decision in `docs/VERIFIER_DESIGN.md` §2).

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, Address, Bytes, Symbol, TryIntoVal,
};

use super::common::*;
use crate::{KeeperError, TaskStatus, TaskType};

#[test]
fn test_update_verifier_sets_and_clears_verifier_on_pending_task() {
    let s = setup();
    let owner = s.admin.clone();
    let verifier = Address::generate(&s.env);

    let task_id = register_default_task(&s);

    // Initial task has no verifier
    assert_eq!(s.registry.get_task(&task_id).verifier, None);

    // Set new verifier
    s.registry.update_verifier(&owner, &task_id, &Some(verifier.clone()));
    assert_eq!(s.registry.get_task(&task_id).verifier, Some(verifier));

    // Clear verifier (None)
    s.registry.update_verifier(&owner, &task_id, &None);
    assert_eq!(s.registry.get_task(&task_id).verifier, None);
}

#[test]
fn test_update_verifier_rejects_claimed_task() {
    let s = setup();
    let owner = s.admin.clone();
    let keeper = Address::generate(&s.env);
    let verifier = Address::generate(&s.env);

    let task_id = register_default_task(&s);

    // Keeper claims task
    s.registry.claim_task(&keeper, &task_id);
    assert_eq!(s.registry.get_task(&task_id).status, TaskStatus::Claimed);

    // Owner attempt to update verifier on claimed task must return InvalidTaskStatus
    let result = s.registry.try_update_verifier(&owner, &task_id, &Some(verifier));
    assert_eq!(result, Err(Ok(KeeperError::InvalidTaskStatus)));
}

#[test]
fn test_update_verifier_rejects_non_owner() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let verifier = Address::generate(&s.env);

    let task_id = register_default_task(&s);

    // Non-owner call must fail with NotTaskOwner
    let result = s.registry.try_update_verifier(&stranger, &task_id, &Some(verifier));
    assert_eq!(result, Err(Ok(KeeperError::NotTaskOwner)));
}

// `pub(crate)` (not private) so `property.rs` can reuse these same fixtures
// for #119's solvency property, per that issue's explicit instruction to
// reuse rather than duplicate.
pub(crate) mod always_approve_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct AlwaysApproveVerifier;

    #[contractimpl]
    impl AlwaysApproveVerifier {
        pub fn verify(_env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            true
        }
    }
}

pub(crate) mod always_reject_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct AlwaysRejectVerifier;

    #[contractimpl]
    impl AlwaysRejectVerifier {
        pub fn verify(_env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            false
        }
    }
}

/// Simulates a fundamentally broken (or malicious) verifier contract, per
/// `docs/VERIFIER_DESIGN.md` §2's investigation into panic isolation.
mod panicking_verifier {
    use soroban_sdk::{contract, contractimpl, Address, Bytes, Env};

    #[contract]
    pub struct PanickingVerifier;

    #[contractimpl]
    impl PanickingVerifier {
        pub fn verify(_env: Env, _task_id: u64, _keeper: Address, _proof: Bytes) -> bool {
            panic!("this verifier is fundamentally broken");
        }
    }
}

/// Registers a standard task with `verifier` attached, funded by `s.admin`.
fn register_verified_task(s: &TestSetup, verifier: &Address) -> u64 {
    let deadline = s.env.ledger().timestamp() + 3_600;
    s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000i128,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &120u32,
        &Some(verifier.clone()),
    )
}

/// Decodes the most recently emitted event's data as `(u64, Address)` — the
/// shape shared by `TaskClaimed`'s first two fields and `TaskVerificationFailed`.
fn last_event_task_id_and_keeper(s: &TestSetup) -> (u64, Address) {
    let events = s.env.events().all();
    let (_contract, _topics, data) = events.last().expect("an event must have been emitted");
    data.try_into_val(&s.env)
        .expect("event data must decode to (task_id, keeper)")
}

// ─────────────────────────────────────────────────────────────────────────────
// Approving verifier — the happy path is unchanged from the no-verifier MVP.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_execute_task_with_approving_verifier_credits_reward_as_usual() {
    let s = setup();
    let verifier_id = s
        .env
        .register(always_approve_verifier::AlwaysApproveVerifier, ());
    let keeper = Address::generate(&s.env);
    let id = register_verified_task(&s, &verifier_id);

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    // No TaskVerificationFailed event fired on the approving path. Read
    // immediately after `execute_task` and before any other contract
    // invocation — including a read-only view — since the test harness's
    // event log reflects only the most recently completed top-level call.
    // Filtered by topic, not by attempting to decode each event's data as
    // `(u64, Address)`: TaskExecuted's data has more fields than that shape,
    // and decoding a mismatched arity is a hard host panic here, not a
    // catchable `Err` — topics are uniformly a 2-symbol pair across every
    // event this contract emits, so decoding those is always safe.
    let events = s.env.events().all();
    for event in events.iter() {
        let topics = event.1;
        if topics.len() != 2 {
            continue;
        }
        let topic0: Symbol = topics.get(0).unwrap().try_into_val(&s.env).unwrap();
        let topic1: Symbol = topics.get(1).unwrap().try_into_val(&s.env).unwrap();
        assert!(
            !(topic0 == symbol_short!("verfail") && topic1 == symbol_short!("task")),
            "an approving verifier must not emit TaskVerificationFailed"
        );
    }

    let (expected_net, _fee) =
        crate::split_reward(1_000_000i128, s.registry.get_fee_bps()).unwrap();
    assert_eq!(s.registry.keeper_balance(&keeper), expected_net);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rejecting verifier — #105's VerificationFailed error + TaskVerificationFailed
// event, and no token movement on rejection.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_execute_task_with_rejecting_verifier_fails_without_moving_funds() {
    let s = setup();
    let verifier_id = s
        .env
        .register(always_reject_verifier::AlwaysRejectVerifier, ());
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = Address::generate(&s.env);
    let id = register_verified_task(&s, &verifier_id);

    s.registry.claim_task(&keeper, &id);
    let registry_balance_before = token.balance(&s.registry.address);

    let result =
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"bad-proof"));
    assert_eq!(result, Err(Ok(KeeperError::VerificationFailed)));

    // TaskVerificationFailed carries the right task_id and keeper. Read
    // immediately after the failing call and before any other contract
    // invocation — including a read-only view — since the test harness's
    // event log reflects only the most recently completed top-level call.
    let (event_task_id, event_keeper) = last_event_task_id_and_keeper(&s);
    assert_eq!(event_task_id, id);
    assert_eq!(event_keeper, keeper);

    // No token movement, no reward credited, task still Claimed (retryable).
    assert_eq!(token.balance(&s.registry.address), registry_balance_before);
    assert_eq!(s.registry.keeper_balance(&keeper), 0);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
    assert_eq!(s.registry.get_task(&id).claimer, Some(keeper.clone()));

    // A retry (different proof, same rejecting verifier) fails the same way —
    // the rejection is repeatable, not a one-shot state change.
    let retry = s
        .registry
        .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"still-bad"));
    assert_eq!(retry, Err(Ok(KeeperError::VerificationFailed)));
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
    assert_eq!(token.balance(&s.registry.address), registry_balance_before);
}

// ─────────────────────────────────────────────────────────────────────────────
// Panicking verifier — proof that a callee panic is caught, not propagated
// (docs/VERIFIER_DESIGN.md §2's decision record).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_execute_task_with_panicking_verifier_is_isolated_as_verification_failed() {
    let s = setup();
    let verifier_id = s.env.register(panicking_verifier::PanickingVerifier, ());
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = Address::generate(&s.env);
    let id = register_verified_task(&s, &verifier_id);

    s.registry.claim_task(&keeper, &id);
    let registry_balance_before = token.balance(&s.registry.address);

    // If the panic propagated (aborted the transaction) rather than being
    // caught, this call itself would panic and fail the test with a host
    // trap instead of returning a value — reaching the assertion below is
    // itself part of the proof that `try_verify` isolates the callee panic.
    let result = s
        .registry
        .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    assert_eq!(result, Err(Ok(KeeperError::VerificationFailed)));

    assert_eq!(token.balance(&s.registry.address), registry_balance_before);
    assert_eq!(s.registry.keeper_balance(&keeper), 0);
    // The task is left exactly as it was — still Claimed, still retryable —
    // per docs/VERIFIER_DESIGN.md §2: a panicking verifier can never brick a
    // task, since `expire_task` also remains available at the deadline.
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Claimed);
}
