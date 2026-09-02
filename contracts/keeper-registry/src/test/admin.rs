//! Admin controls: pause, fees, admin transfer, and upgrade.

use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token, Address, Bytes, IntoVal, TryIntoVal,
};

use super::common::*;
use crate::{KeeperError, TaskStatus, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// Admin controls: pause / set_fee_bps / transfer_admin / upgrade
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_pause_blocks_registration_but_allows_withdraw() {
    let s = setup();
    let keeper = executed_task_keeper(&s); // has a balance to withdraw

    s.registry.pause(&s.admin);
    assert!(s.registry.is_paused());

    // Registration is blocked while paused.
    assert_eq!(
        s.registry.try_register_task(
            &s.admin,
            &TaskType::Custom,
            &calldata(&s.env),
            &100_000i128,
            &(s.env.ledger().timestamp() + 3_600),
            &DEFAULT_TTL_LEDGERS,
            &60u32,
            &None,
        ),
        Err(Ok(KeeperError::ContractPaused))
    );

    // Withdrawals remain open during a pause so funds are never trapped.
    assert_eq!(s.registry.withdraw_rewards(&keeper), 970_000i128);
}

#[test]
fn test_unpause_restores_registration() {
    let s = setup();
    s.registry.pause(&s.admin);
    s.registry.unpause(&s.admin);
    assert!(!s.registry.is_paused());
    // Now registration works again.
    let id = register_default_task(&s);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Pending);
}

#[test]
fn test_pause_emits_event() {
    let s = setup();
    s.registry.pause(&s.admin);
    // A governance event was published for the pause.
    assert!(!s.env.events().all().is_empty());
}

#[test]
fn test_pause_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_pause(&stranger),
        Err(Ok(KeeperError::Unauthorized))
    );
}

/// Table-driven coverage of the full pause policy, entry point by entry
/// point — see the `pause`/`unpause` doc comment in `lib.rs` for the table
/// this test verifies against and keeps in sync.
///
/// Ground truth is "does the function call `require_not_paused(&e)?`",
/// checked directly against the code (not the old prose-only doc comment,
/// which undersold the policy — it only mentioned
/// register_task/claim_task/execute_task/expire_task/withdraw_rewards and
/// said nothing about increase_reward, extend_deadline, or cancel_task):
///
///   - BLOCKED while paused (asserted via `try_*` -> `ContractPaused`):
///     `register_task`, `claim_task`, `execute_task`, `increase_reward`,
///     `extend_deadline`.
///   - Allowed while paused, and asserted to have their full intended
///     effect (not just "didn't error"): `cancel_task` (refund + status),
///     `expire_task` (refund + status), `withdraw_rewards` (balance
///     transferred + zeroed).
///   - Read-only views are asserted to keep working throughout.
///   - Finally, unpause restores every previously-blocked entry point —
///     a one-way pause would itself be a serious bug.
#[test]
fn test_pause_policy_matrix_entry_point_by_entry_point() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);

    // ── Arrange: every task needs to exist *before* pausing, since
    // register_task itself is blocked once paused.
    let claim_target_id = register_default_task(&s); // Pending -> claim_task blocked
    let increase_target_id = register_default_task(&s); // Pending -> increase_reward blocked
    let cancel_target_id = register_default_task(&s); // Pending -> cancel_task allowed
    let extend_target_id = register_default_task(&s); // Pending -> extend_deadline (bug: allowed)

    // Short deadline so it can expire without dragging the other tasks'
    // (default +3_600s) deadlines past their own while paused.
    let expire_target_id = s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000i128,
        &(s.env.ledger().timestamp() + 100),
        &DEFAULT_TTL_LEDGERS,
        &120u32,
        &None,
    );

    let claimed_keeper = Address::generate(&s.env);
    let claimed_task_id = register_default_task(&s);
    s.registry.claim_task(&claimed_keeper, &claimed_task_id); // Claimed -> execute_task blocked

    // Credited before pausing, since execute_task (the only way to credit a
    // keeper) is itself blocked once paused.
    let paid_keeper = executed_task_keeper(&s); // has a withdrawable balance

    // ── Act: pause.
    s.registry.pause(&s.admin);
    assert!(s.registry.is_paused());

    // ── BLOCKED: register_task.
    assert_eq!(
        s.registry.try_register_task(
            &s.admin,
            &TaskType::Custom,
            &calldata(&s.env),
            &100_000i128,
            &(s.env.ledger().timestamp() + 3_600),
            &DEFAULT_TTL_LEDGERS,
            &60u32,
            &None,
        ),
        Err(Ok(KeeperError::ContractPaused))
    );

    // ── BLOCKED: claim_task.
    assert_eq!(
        s.registry
            .try_claim_task(&Address::generate(&s.env), &claim_target_id),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(
        s.registry.get_task(&claim_target_id).status,
        TaskStatus::Pending
    ); // untouched

    // ── BLOCKED: execute_task.
    assert_eq!(
        s.registry.try_execute_task(
            &claimed_keeper,
            &claimed_task_id,
            &Bytes::from_slice(&s.env, b"p"),
        ),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(
        s.registry.get_task(&claimed_task_id).status,
        TaskStatus::Claimed
    ); // untouched

    // ── BLOCKED: increase_reward.
    assert_eq!(
        s.registry
            .try_increase_reward(&s.admin, &increase_target_id, &1i128),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(
        s.registry.get_task(&increase_target_id).reward,
        1_000_000i128
    ); // untouched

    // ── BLOCKED: extend_deadline — gated as of the fix for issue #20. It
    // touches no funds directly, but leaving it open while paused would let
    // an owner keep escrow locked in a contract the admin has declared
    // unsafe, working against the point of the pause.
    let old_deadline = s.registry.get_task(&extend_target_id).deadline;
    assert_eq!(
        s.registry
            .try_extend_deadline(&s.admin, &extend_target_id, &(old_deadline + 3_600)),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(
        s.registry.get_task(&extend_target_id).deadline,
        old_deadline
    ); // untouched

    // ── ALLOWED: cancel_task — must actually refund and flip status, not
    // just "not error".
    let admin_before_cancel = token.balance(&s.admin);
    s.registry.cancel_task(&s.admin, &cancel_target_id);
    assert_eq!(
        s.registry.get_task(&cancel_target_id).status,
        TaskStatus::Cancelled
    );
    assert_eq!(token.balance(&s.admin), admin_before_cancel + 1_000_000i128);

    // ── ALLOWED: expire_task, once its deadline passes — also must actually
    // refund and flip status. Advance just enough to pass this task's short
    // deadline without also passing the other (default +3_600s) tasks'.
    advance(&s.env, 5, 101);
    let admin_before_expire = token.balance(&s.admin);
    s.registry.expire_task(&expire_target_id);
    assert_eq!(
        s.registry.get_task(&expire_target_id).status,
        TaskStatus::Expired
    );
    assert_eq!(token.balance(&s.admin), admin_before_expire + 1_000_000i128);

    // ── ALLOWED: withdraw_rewards — must actually transfer and zero the
    // balance, not just "not error".
    assert_eq!(token.balance(&paid_keeper), 0i128);
    assert_eq!(s.registry.withdraw_rewards(&paid_keeper), 970_000i128);
    assert_eq!(token.balance(&paid_keeper), 970_000i128);
    assert_eq!(s.registry.keeper_balance(&paid_keeper), 0i128);

    // ── ALLOWED: read-only views never gate on pause.
    assert!(s.registry.is_paused());
    assert_eq!(s.registry.fees_accrued(), 30_000i128);
    assert!(s.registry.task_count() >= 6);
    assert_eq!(s.registry.admin(), Some(s.admin.clone()));
    assert_eq!(s.registry.get_fee_bps(), 300u32);

    // ── Unpause: every previously-blocked entry point must work again — a
    // one-way pause would itself be a serious liveness bug.
    s.registry.unpause(&s.admin);
    assert!(!s.registry.is_paused());

    // register_task works again.
    let new_id = register_default_task(&s);
    assert_eq!(s.registry.get_task(&new_id).status, TaskStatus::Pending);

    // claim_task works again.
    let claimer = Address::generate(&s.env);
    s.registry.claim_task(&claimer, &claim_target_id);
    assert_eq!(
        s.registry.get_task(&claim_target_id).status,
        TaskStatus::Claimed
    );

    // execute_task works again.
    s.registry.execute_task(
        &claimed_keeper,
        &claimed_task_id,
        &Bytes::from_slice(&s.env, b"proof"),
    );
    assert_eq!(
        s.registry.get_task(&claimed_task_id).status,
        TaskStatus::Executed
    );

    // increase_reward works again.
    s.registry
        .increase_reward(&s.admin, &increase_target_id, &1i128);
    assert_eq!(
        s.registry.get_task(&increase_target_id).reward,
        1_000_001i128
    );
}

#[test]
fn test_set_fee_bps_affects_future_executions() {
    let s = setup();
    s.registry.set_fee_bps(&s.admin, &1_000u32); // 10%
    assert_eq!(s.registry.get_fee_bps(), 1_000u32);

    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));

    // 10% fee now: keeper nets 900_000, 100_000 accrues.
    assert_eq!(s.registry.keeper_balance(&keeper), 900_000i128);
    assert_eq!(s.registry.fees_accrued(), 100_000i128);
}

#[test]
fn test_min_reward_defaults_to_zero() {
    let s = setup();
    assert_eq!(s.registry.min_reward(), 0i128);
}

#[test]
fn test_set_min_reward_rejects_below_floor() {
    let s = setup();
    s.registry.set_min_reward(&s.admin, &500_000i128);
    assert_eq!(s.registry.min_reward(), 500_000i128);

    // A task below the floor is rejected...
    assert_eq!(
        s.registry.try_register_task(
            &s.admin,
            &TaskType::Custom,
            &calldata(&s.env),
            &499_999i128,
            &(s.env.ledger().timestamp() + 3_600),
            &DEFAULT_TTL_LEDGERS,
            &60u32,
            &None,
        ),
        Err(Ok(KeeperError::InvalidReward))
    );
    // ...but one at the floor is accepted.
    let id = s.registry.register_task(
        &s.admin,
        &TaskType::Custom,
        &calldata(&s.env),
        &500_000i128,
        &(s.env.ledger().timestamp() + 3_600),
        &DEFAULT_TTL_LEDGERS,
        &60u32,
        &None,
    );
    assert_eq!(id, 1u64);
}

#[test]
fn test_set_min_reward_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_set_min_reward(&stranger, &1i128),
        Err(Ok(KeeperError::Unauthorized))
    );
}

#[test]
fn test_set_fee_emits_event() {
    let s = setup();
    let old_bps = s.registry.get_fee_bps();
    let new_bps = 500u32;
    s.registry.set_fee_bps(&s.admin, &new_bps);

    // `events().all()` only reflects the most recent top-level invocation, so
    // this matches on the emitted payload rather than a count delta.
    let found = s
        .env
        .events()
        .all()
        .iter()
        .any(|event| event.2.try_into_val(&s.env) == Ok((old_bps, new_bps)));
    assert!(found, "FeeUpdated event was not emitted");
}

#[test]
fn test_set_fee_over_max_fails() {
    let s = setup();
    assert_eq!(
        s.registry.try_set_fee_bps(&s.admin, &10_001u32),
        Err(Ok(KeeperError::InvalidFeeBps))
    );
}

#[test]
fn test_transfer_admin_moves_control() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.registry.transfer_admin(&s.admin, &new_admin);
    assert_eq!(s.registry.admin(), Some(new_admin.clone()));

    // Old admin can no longer act.
    assert_eq!(
        s.registry.try_pause(&s.admin),
        Err(Ok(KeeperError::Unauthorized))
    );
    // New admin can.
    s.registry.pause(&new_admin);
    assert!(s.registry.is_paused());
}

#[test]
fn test_transfer_admin_emits_event() {
    let s = setup();
    let old_admin = s.admin.clone();
    let new_admin = Address::generate(&s.env);
    s.registry.transfer_admin(&old_admin, &new_admin);

    // `events().all()` only reflects the most recent top-level invocation, so
    // this matches on the emitted payload rather than a count delta.
    let found =
        s.env.events().all().iter().any(|event| {
            event.2.try_into_val(&s.env) == Ok((old_admin.clone(), new_admin.clone()))
        });
    assert!(found, "AdminTransferred event was not emitted");
}

// ─────────────────────────────────────────────────────────────────────────────
// transfer_admin — dual authorization
//
// `transfer_admin` calls both `require_admin` (which requires the *current*
// admin's auth) and `new_admin.require_auth()`, so the role can never be
// pushed onto an address that has not consented to take it. Every test above
// runs under `setup()`'s `env.mock_all_auths()`, which satisfies every
// `require_auth()` regardless of who "signed" — so it cannot distinguish a
// working dual-auth check from a deleted one. These three tests deliberately
// use `mock_auths` with an explicit, minimal authorization list instead, so
// they actually exercise the guard. Do not "simplify" these to
// `mock_all_auths()` — that would silently remove the only coverage of this
// safety property.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_transfer_admin_fails_without_new_admin_auth() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    // Authorize only the current admin. The incoming admin has not consented.
    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.registry.address,
            fn_name: "transfer_admin",
            args: (s.admin.clone(), new_admin.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);

    let result = s.registry.try_transfer_admin(&s.admin, &new_admin);
    assert!(
        result.is_err(),
        "transfer must fail without the incoming admin's auth"
    );
    // The consequence that actually matters: admin is unchanged.
    assert_eq!(s.registry.admin(), Some(s.admin.clone()));
}

#[test]
fn test_transfer_admin_fails_without_current_admin_auth() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    // Authorize only the incoming admin. The current admin did not sign.
    s.env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &s.registry.address,
            fn_name: "transfer_admin",
            args: (s.admin.clone(), new_admin.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);

    let result = s.registry.try_transfer_admin(&s.admin, &new_admin);
    assert!(
        result.is_err(),
        "transfer must fail without the current admin's auth"
    );
    assert_eq!(s.registry.admin(), Some(s.admin.clone()));
}

#[test]
fn test_transfer_admin_succeeds_with_both_auths_explicit() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    // Both required parties authorize explicitly (no mock_all_auths involved),
    // proving the harness itself is capable of making the call succeed.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.registry.address,
                fn_name: "transfer_admin",
                args: (s.admin.clone(), new_admin.clone()).into_val(&s.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &s.registry.address,
                fn_name: "transfer_admin",
                args: (s.admin.clone(), new_admin.clone()).into_val(&s.env),
                sub_invokes: &[],
            },
        },
    ]);

    let result = s.registry.try_transfer_admin(&s.admin, &new_admin);
    assert!(
        result.is_ok(),
        "transfer must succeed when both parties explicitly authorize"
    );
    assert_eq!(s.registry.admin(), Some(new_admin));
}
