//! Fuzz target for the shared, configurable `ReentrantToken` mock
//! (`keeper_registry::mocks`, issue #203 / backlog 0056).
//!
//! The hand-written CEI regression tests in `test/cancel.rs` and
//! `test/expire.rs` each exercise the shared mock against one fixed target.
//! This target instead randomizes, per run: which payout path is targeted
//! for reentrancy (`cancel_task`, `expire_task`, or `withdraw_rewards` — the
//! only three entry points that call `reward_token(&e)?.transfer(...)` out
//! of the registry today) and whether the re-entrant call fires before or
//! after the token's own balance update.
//!
//! The property under test is the same one the hand-written regressions
//! prove for their one fixed case each: no matter which payout path or
//! timing is picked, the re-entrant call must never succeed, and any
//! rejection it does hit must be a documented, expected error rather than an
//! unexpected variant or a host-level trap.

#![no_main]

use arbitrary::{Arbitrary, Unstructured};
use keeper_registry::mocks::{
    ReentrantToken, ReentrantTokenClient, NO_ERROR_CODE, POINT_AFTER_BALANCE_UPDATE,
    POINT_BEFORE_BALANCE_UPDATE, TARGET_CANCEL_TASK, TARGET_EXPIRE_TASK,
    TARGET_WITHDRAW_REWARDS,
};
use keeper_registry::{KeeperError, KeeperRegistry, KeeperRegistryClient, TaskType};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Bytes, Env};

/// `ttl_ledgers` covering this target's fixed 3_600s deadline — see
/// `contracts/keeper-registry/src/test/common.rs`'s `DEFAULT_TTL_LEDGERS`
/// for the same value and the rule it satisfies.
const TTL_LEDGERS: u32 = 18_000;

#[derive(Arbitrary, Debug)]
struct ReentrancyInput {
    target_selector: u8,
    point_selector: u8,
    reward_bytes: [u8; 16], // i128
}

fn target_for(selector: u8) -> u32 {
    match selector % 3 {
        0 => TARGET_CANCEL_TASK,
        1 => TARGET_EXPIRE_TASK,
        _ => TARGET_WITHDRAW_REWARDS,
    }
}

fn point_for(selector: u8) -> u32 {
    if selector % 2 == 0 {
        POINT_BEFORE_BALANCE_UPDATE
    } else {
        POINT_AFTER_BALANCE_UPDATE
    }
}

fuzz_target!(|data: &[u8]| {
    let mut unstructured = Unstructured::new(data);
    let Ok(input) = ReentrancyInput::arbitrary(&mut unstructured) else {
        return;
    };

    let reward = i128::from_le_bytes(input.reward_bytes).unsigned_abs() as i128
        % 1_000_000_000
        + 1;
    let target = target_for(input.target_selector);
    let point = point_for(input.point_selector);

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let keeper = Address::generate(&env);

    let token_id = env.register(ReentrantToken, ());
    let token = ReentrantTokenClient::new(&env, &token_id);
    token.mint(&admin, &(reward * 10));

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    let deadline = env.ledger().timestamp() + 3_600;
    let task_id = registry.register_task(
        &admin,
        &TaskType::Liquidation,
        &Bytes::from_slice(&env, b""),
        &reward,
        &deadline,
        &TTL_LEDGERS,
        &120u32,
    );

    // The re-entrant call's trigger address is whoever the targeted
    // function's own outgoing transfer pays: the task owner for a refund
    // (cancel/expire), the keeper for a withdrawal.
    let trigger_to = if target == TARGET_WITHDRAW_REWARDS {
        keeper.clone()
    } else {
        admin.clone()
    };

    match target {
        TARGET_CANCEL_TASK => {
            token.arm(
                &registry_id,
                &trigger_to,
                &target,
                &point,
                &admin,
                &task_id,
                &keeper,
            );
            let _ = registry.try_cancel_task(&admin, &task_id);
        }
        TARGET_EXPIRE_TASK => {
            env.ledger().with_mut(|li| li.timestamp += 3_601);
            token.arm(
                &registry_id,
                &trigger_to,
                &target,
                &point,
                &admin,
                &task_id,
                &keeper,
            );
            let _ = registry.try_expire_task(&task_id);
        }
        TARGET_WITHDRAW_REWARDS => {
            // Drive a full claim + execute cycle first so the keeper has a
            // credited balance for withdraw_rewards to pay out.
            registry.claim_task(&keeper, &task_id);
            registry.execute_task(&keeper, &task_id, &Bytes::from_slice(&env, b"proof"));
            token.arm(
                &registry_id,
                &trigger_to,
                &target,
                &point,
                &admin,
                &task_id,
                &keeper,
            );
            let _ = registry.try_withdraw_rewards(&keeper);
        }
        _ => unreachable!("target_for only returns the three TARGET_* constants above"),
    }

    // The core property, regardless of which payout path or timing this run
    // picked: the re-entrant call must never have succeeded.
    assert!(
        !token.reentry_succeeded(),
        "re-entrant call succeeded for target {target} at point {point} — CEI ordering broken"
    );

    // If it fired and was rejected by this contract's own guard (rather
    // than the host's independent reentrancy protection, which reports
    // NO_ERROR_CODE), the rejection must be the one documented outcome for a
    // same-task-id / same-keeper re-entrant call into whichever function
    // this run targeted — never an unexpected variant.
    if token.reentry_fired() {
        let code = token.reentry_error_code();
        let expected_error = match target {
            TARGET_CANCEL_TASK | TARGET_EXPIRE_TASK => KeeperError::InvalidTaskStatus,
            TARGET_WITHDRAW_REWARDS => KeeperError::NoRewardsAvailable,
            _ => unreachable!("target_for only returns the three TARGET_* constants above"),
        };
        assert!(
            code == NO_ERROR_CODE || code == expected_error as u32,
            "re-entrant call for target {target} was rejected with an unexpected KeeperError \
             code {code} (expected NO_ERROR_CODE or {expected_error:?})"
        );
    }
});
