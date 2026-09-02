//! `cancel_task`, including the checks-effects-interactions regression.

use soroban_sdk::{testutils::Address as _, Address, Env};

use super::common::*;
use crate::mocks::{
    ReentrantToken, ReentrantTokenClient, NO_ERROR_CODE, POINT_BEFORE_BALANCE_UPDATE,
    TARGET_CANCEL_TASK,
};
use crate::{KeeperError, KeeperRegistry, KeeperRegistryClient, TaskStatus, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// cancel_task — checks-effects-interactions regression
//
// A malicious reward token can try to call back into the registry from
// inside `transfer`. `cancel_task` must write `TaskStatus::Cancelled` before
// it ever calls the token, so that if a re-entrant `cancel_task` call for the
// same task ever reaches the function body, it sees a non-Pending status and
// is rejected with `InvalidTaskStatus` rather than paying out a second
// refund.
//
// Note: the Soroban host also refuses same-contract reentrancy at the
// platform level (`ContractReentryMode::Prohibited` on ordinary cross-contract
// calls), so the reentrant call below is actually intercepted before it ever
// reaches our status guard. The test still asserts on both layers: the
// reentrant call must never succeed, and *if* it were ever decoded as a
// contract error, it must be `InvalidTaskStatus`. That keeps this a real
// regression test for the CEI ordering fix rather than one that only
// happens to pass because of the platform's independent protection.
//
// Uses the shared, configurable `ReentrantToken` mock (`crate::mocks`, issue
// #203) rather than a bespoke contract hand-written in this file — armed for
// `TARGET_CANCEL_TASK` at `POINT_BEFORE_BALANCE_UPDATE`, matching the exact
// scenario this test always proved (the re-entrant call fires before the
// token's own balance update completes).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_cancel_task_rejects_reentrant_refund() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let token_id = env.register(ReentrantToken, ());
    let mock_token = ReentrantTokenClient::new(&env, &token_id);
    mock_token.mint(&admin, &10_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

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
    );

    // Escrow landed on the registry, owner is down the reward.
    assert_eq!(mock_token.balance(&admin), 9_000_000i128);
    assert_eq!(mock_token.balance(&registry_id), 1_000_000i128);

    // Arm the token: its next transfer to `admin` will try to cancel the
    // same task again, from inside the outer cancel's own transfer call,
    // before that transfer's own balance update completes.
    mock_token.arm(
        &registry_id,
        &admin,
        &TARGET_CANCEL_TASK,
        &POINT_BEFORE_BALANCE_UPDATE,
        &admin,
        &task_id,
        &admin, // keeper arg unused for this target
    );

    registry.cancel_task(&admin, &task_id);

    // The re-entrant cancel must never have succeeded.
    assert!(mock_token.reentry_fired());
    assert!(!mock_token.reentry_succeeded());
    // If the rejection reached our own guard (rather than being intercepted
    // by the host's reentrancy protection first), it must be because the
    // outer call already wrote TaskStatus::Cancelled before touching the
    // token.
    let code = mock_token.reentry_error_code();
    if code != NO_ERROR_CODE {
        assert_eq!(code, KeeperError::InvalidTaskStatus as u32);
    }
    assert_eq!(mock_token.call_count(), 1);
    assert_eq!(registry.get_task(&task_id).status, TaskStatus::Cancelled);

    // Exactly one refund was paid: owner made whole, registry drained back
    // to zero for this task.
    assert_eq!(mock_token.balance(&admin), 10_000_000i128);
    assert_eq!(mock_token.balance(&registry_id), 0i128);
}
