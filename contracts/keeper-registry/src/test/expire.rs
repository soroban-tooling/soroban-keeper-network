//! `expire_task`, including the re-entrancy regression.

use soroban_sdk::{testutils::Address as _, token, Address, Env};

use super::common::*;
use crate::mocks::{
    ReentrantToken, ReentrantTokenClient, POINT_AFTER_BALANCE_UPDATE, TARGET_EXPIRE_TASK,
};
use crate::{KeeperError, KeeperRegistry, KeeperRegistryClient, TaskStatus, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// Re-entrancy regression: expire_task
//
// A malicious or buggy reward token whose `transfer` re-enters `expire_task`
// for the same task_id mid-transfer.
//
// In practice Soroban's host already refuses to re-invoke a contract that is
// still on the call stack, so the nested call below is rejected by the host
// itself rather than reaching our `InvalidTaskStatus` guard — see the
// `reentry_error_code` assertion. That host protection is not something this
// contract can rely on as its only line of defense (it is a platform detail,
// not a documented guarantee of this contract's ABI), so the
// checks-effects-interactions fix still matters: this test's real assertion
// is that no matter why the second attempt was rejected, it never reaches a
// second `transfer`, so the refund is paid exactly once.
//
// Uses the shared, configurable `ReentrantToken` mock (`crate::mocks`, issue
// #203) rather than a bespoke contract hand-written in this file — armed for
// `TARGET_EXPIRE_TASK` at `POINT_AFTER_BALANCE_UPDATE`, matching the exact
// scenario this test always proved (the re-entrant call fires after the
// refund transfer's own balance update completes).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_expire_task_reentrancy_pays_refund_exactly_once() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(ReentrantToken, ());
    let token = ReentrantTokenClient::new(&env, &token_id);
    token.mint(&admin, &5_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    let deadline = env.ledger().timestamp() + 3_600;
    let task_id = registry.register_task(
        &admin,
        &TaskType::Custom,
        &calldata(&env),
        &1_000_000i128,
        &deadline,
        &DEFAULT_TTL_LEDGERS,
        &120u32,
    );
    assert_eq!(token.balance(&admin), 4_000_000i128); // escrowed
    assert_eq!(token.balance(&registry_id), 1_000_000i128);

    // Arm the token only now, so the escrow transfer above isn't itself
    // treated as a re-entrant call. The refund transfer targets `admin`, so
    // that's the trigger address.
    token.arm(
        &registry_id,
        &admin,
        &TARGET_EXPIRE_TASK,
        &POINT_AFTER_BALANCE_UPDATE,
        &admin,
        &task_id,
        &admin, // keeper arg unused for this target
    );

    advance(&env, 1, 3_601); // past deadline
    registry.expire_task(&task_id);

    // The nested call never succeeded — either rejected by our own guard
    // with InvalidTaskStatus, or by the host's built-in reentrancy
    // protection. Either way it never ran a second transfer.
    assert!(token.reentry_fired());
    assert!(
        !token.reentry_succeeded(),
        "the re-entrant expire_task call must not succeed"
    );

    // Exactly one refund reached the owner; the contract holds nothing.
    assert_eq!(token.balance(&admin), 5_000_000i128);
    assert_eq!(token.balance(&registry_id), 0i128);
    assert_eq!(registry.get_task(&task_id).status, TaskStatus::Expired);
}

#[test]
fn test_expire_twice_fails_with_invalid_status_and_pays_refund_once() {
    // Direct, non-reentrant demonstration of the same CEI guarantee: once
    // `expire_task` has written `Expired`, any further call for the same
    // task_id — reentrant or not — is rejected before it can transfer again.
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let id = register_default_task(&s);

    advance(&s.env, 1, 3_601); // past deadline
    s.registry.expire_task(&id);
    assert_eq!(token.balance(&s.admin), before); // refunded once

    assert_eq!(
        s.registry.try_expire_task(&id),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
    assert_eq!(token.balance(&s.admin), before); // still exactly one refund
    assert_eq!(token.balance(&s.registry.address), 0i128);
}
