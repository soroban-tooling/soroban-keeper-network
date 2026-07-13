//! # KeeperRegistry — Test Suite
//!
//! Covers the full task lifecycle (register → claim → execute → withdraw) plus
//! the refund paths (cancel/expire), fee accounting, and every admin control.
//!
//! ## For contributors
//! When you add a function, add tests here. Every public function should have:
//!   - one happy-path test
//!   - a test for each KeeperError variant it can return
//!
//! Run with: `cargo test -p keeper-registry`

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token, Address, Bytes, Env,
};

use crate::{
    split_reward, KeeperError, KeeperRegistry, KeeperRegistryClient, TaskStatus, TaskType,
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared test setup
// ─────────────────────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    admin: Address,
    registry: KeeperRegistryClient<'static>,
    token_id: Address,
}

// The transmutes below intentionally re-bind the env/client to a 'static
// lifetime — the standard Soroban test-harness pattern for a shared Setup.
#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Deploy a SAC-wrapped token to use as the reward currency.
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    token::StellarAssetClient::new(&env, &token_id).mint(&admin, &10_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    // Leak env to get a 'static lifetime — standard soroban test pattern.
    let env = unsafe { core::mem::transmute::<Env, Env>(env) };
    Setup {
        env,
        admin,
        registry: unsafe { core::mem::transmute(registry) },
        token_id,
    }
}

fn calldata(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"liquidate:position:42")
}

/// Registers a standard 1-hour task funded by `admin` and returns its id.
fn register_default_task(s: &Setup) -> u64 {
    let deadline = s.env.ledger().timestamp() + 3_600;
    s.registry.register_task(
        &s.admin,
        &TaskType::Liquidation,
        &calldata(&s.env),
        &1_000_000i128,
        &deadline,
        &17_280u32,
        &120u32,
    )
}

/// Advances the ledger sequence and timestamp so lock-window / deadline logic
/// can be exercised deterministically.
fn advance(env: &Env, ledgers: u32, seconds: u64) {
    env.ledger().with_mut(|li| {
        li.sequence_number += ledgers;
        li.timestamp += seconds;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// initialize
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end integration: multiple tasks, multiple keepers
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_multi_keeper_end_to_end_conserves_funds() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let k1 = Address::generate(&s.env);
    let k2 = Address::generate(&s.env);

    // Three tasks funded from admin, 1_000_000 each.
    let t_exec = register_default_task(&s); // will be executed by k1
    let t_expire = register_default_task(&s); // will be claimed by k2 then expire
    let t_cancel = register_default_task(&s); // will be cancelled by owner

    // The contract now escrows all three rewards.
    assert_eq!(token.balance(&s.registry.address), 3_000_000i128);

    // k1 executes the first task (3% fee → 970_000 to k1, 30_000 accrued).
    s.registry.claim_task(&k1, &t_exec);
    s.registry
        .execute_task(&k1, &t_exec, &Bytes::from_slice(&s.env, b"p1"));

    // k2 claims the second but never executes; owner cancels the third now.
    s.registry.claim_task(&k2, &t_expire);
    s.registry.cancel_task(&s.admin, &t_cancel); // refunds 1_000_000

    // Time passes; the abandoned task is expired permissionlessly.
    advance(&s.env, 200, 3_601);
    s.registry.expire_task(&t_expire); // refunds 1_000_000 to owner

    // k1 withdraws its earnings; admin sweeps the fee.
    assert_eq!(s.registry.withdraw_rewards(&k1), 970_000i128);
    let treasury = Address::generate(&s.env);
    s.registry.sweep_fees(&s.admin, &treasury, &30_000i128);

    // Conservation: the contract should hold nothing left over — every stroop
    // is now either with the keeper, the treasury, or refunded to the owner.
    assert_eq!(token.balance(&s.registry.address), 0i128);
    assert_eq!(token.balance(&k1), 970_000i128);
    assert_eq!(token.balance(&treasury), 30_000i128);
    assert_eq!(s.registry.fees_accrued(), 0i128);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-function invariants: split_reward
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_split_reward_invariants() {
    // Exhaustively sweep a grid of rewards and fee rates and assert the core
    // accounting invariants hold for every combination — no value is ever
    // created or destroyed by the split.
    let rewards = [
        1i128,
        2,
        7,
        100,
        999,
        1_000_000,
        7_777_777,
        i128::from(u64::MAX),
    ];
    let fee_rates = [0u32, 1, 3, 250, 300, 1_000, 5_000, 9_999, 10_000];

    for &reward in &rewards {
        for &bps in &fee_rates {
            let (keeper_net, fee) = split_reward(reward, bps);

            // 1. Conservation: nothing leaks.
            assert_eq!(keeper_net + fee, reward, "reward={reward} bps={bps}");
            // 2. Non-negative shares.
            assert!(keeper_net >= 0 && fee >= 0, "reward={reward} bps={bps}");
            // 3. Fee never exceeds the reward.
            assert!(fee <= reward, "reward={reward} bps={bps}");
            // 4. Fee matches the basis-point formula (floor division).
            assert_eq!(
                fee,
                reward * bps as i128 / 10_000,
                "reward={reward} bps={bps}"
            );
        }
    }
}

#[test]
fn test_version_is_exposed() {
    let s = setup();
    assert_eq!(s.registry.version(), 1u32);
}

#[test]
fn test_initialize_sets_state() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    registry.initialize(&admin, &token_id, &300u32);

    assert_eq!(registry.admin(), Some(admin));
    assert_eq!(registry.get_fee_bps(), 300u32);
    assert!(!registry.is_paused());
    assert_eq!(registry.reward_token_address(), Some(token_id));
    assert_eq!(registry.task_count(), 0u64);
}

#[test]
fn test_initialize_twice_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    registry.initialize(&admin, &token_id, &300u32);
    assert_eq!(
        registry.try_initialize(&admin, &token_id, &300u32),
        Err(Ok(KeeperError::AlreadyInitialized))
    );
}

#[test]
fn test_initialize_fee_over_10000_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    assert_eq!(
        registry.try_initialize(&admin, &token_id, &10_001u32),
        Err(Ok(KeeperError::InvalidFeeBps))
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// register_task
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_register_task_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    token::StellarAssetClient::new(&env, &token_id).mint(&admin, &5_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    let deadline = env.ledger().timestamp() + 3_600; // 1 hour
    let task_id = registry.register_task(
        &admin,
        &TaskType::Liquidation,
        &calldata(&env),
        &1_000_000i128,
        &deadline,
        &17_280u32,
        &120u32,
    );

    assert_eq!(task_id, 1u64);
    assert_eq!(registry.task_count(), 1u64);

    let task = registry.get_task(&1u64);
    assert_eq!(task.owner, admin);
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.reward, 1_000_000i128);
    assert_eq!(task.deadline, deadline);
    assert!(task.claimer.is_none());
}

#[test]
fn test_register_task_escrows_reward() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let sac = token::StellarAssetClient::new(&env, &token_id);
    sac.mint(&admin, &5_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    let token = token::Client::new(&env, &token_id);
    let owner_before = token.balance(&admin);

    registry.register_task(
        &admin,
        &TaskType::Custom,
        &calldata(&env),
        &1_000_000i128,
        &(env.ledger().timestamp() + 3_600),
        &17_280u32,
        &120u32,
    );

    // Owner balance decreased by the escrowed reward.
    assert_eq!(token.balance(&admin), owner_before - 1_000_000i128);
    // Contract holds the escrow.
    assert_eq!(token.balance(&registry_id), 1_000_000i128);
}

#[test]
fn test_register_task_zero_reward_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    assert_eq!(
        registry.try_register_task(
            &admin,
            &TaskType::Custom,
            &calldata(&env),
            &0i128,
            &(env.ledger().timestamp() + 3_600),
            &17_280u32,
            &120u32,
        ),
        Err(Ok(KeeperError::InvalidReward))
    );
}

#[test]
fn test_register_task_past_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    // Deadline in the past.
    let past = env.ledger().timestamp().saturating_sub(1);
    assert_eq!(
        registry.try_register_task(
            &admin,
            &TaskType::Custom,
            &calldata(&env),
            &1_000_000i128,
            &past,
            &17_280u32,
            &120u32,
        ),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_register_increments_task_counter() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    token::StellarAssetClient::new(&env, &token_id).mint(&admin, &10_000_000i128);

    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32);

    let deadline = env.ledger().timestamp() + 3_600;
    for expected_id in 1u64..=3 {
        let id = registry.register_task(
            &admin,
            &TaskType::TtlExtension,
            &calldata(&env),
            &100_000i128,
            &deadline,
            &17_280u32,
            &60u32,
        );
        assert_eq!(id, expected_id);
    }
    assert_eq!(registry.task_count(), 3u64);
}

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder tests for unimplemented functions
//
// These are intentionally left as stubs. When you implement a function,
// remove the #[ignore] tag and fill in the test body.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_increase_reward_escrows_and_raises_bounty() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let id = register_default_task(&s); // reward 1_000_000
    let contract_before = token.balance(&s.registry.address);

    s.registry.increase_reward(&s.admin, &id, &500_000i128);

    assert_eq!(s.registry.get_task(&id).reward, 1_500_000i128);
    assert_eq!(
        token.balance(&s.registry.address),
        contract_before + 500_000i128
    );
}

#[test]
fn test_increase_reward_by_non_owner_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_increase_reward(&stranger, &id, &1i128),
        Err(Ok(KeeperError::NotTaskOwner))
    );
}

#[test]
fn test_extend_deadline_pushes_it_out() {
    let s = setup();
    let id = register_default_task(&s);
    let old = s.registry.get_task(&id).deadline;

    s.registry.extend_deadline(&s.admin, &id, &(old + 7_200));
    assert_eq!(s.registry.get_task(&id).deadline, old + 7_200);
}

#[test]
fn test_extend_deadline_backwards_fails() {
    let s = setup();
    let id = register_default_task(&s);
    let old = s.registry.get_task(&id).deadline;
    // A new deadline that isn't strictly later is rejected.
    assert_eq!(
        s.registry.try_extend_deadline(&s.admin, &id, &old),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_is_claimable_lifecycle() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    assert!(s.registry.is_claimable(&id)); // Pending → claimable
    s.registry.claim_task(&keeper, &id);
    assert!(!s.registry.is_claimable(&id)); // Claimed, lock active → not

    advance(&s.env, 121, 60); // lock window elapses
    assert!(s.registry.is_claimable(&id)); // re-claimable

    advance(&s.env, 1, 3_601); // past deadline
    assert!(!s.registry.is_claimable(&id)); // deadline passed → not
    assert!(!s.registry.is_claimable(&999u64)); // unknown → not
}

#[test]
fn test_claim_pending_task() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);

    let task = s.registry.get_task(&id);
    assert_eq!(task.status, TaskStatus::Claimed);
    assert_eq!(task.claimer, Some(keeper));
    assert!(task.claim_ledger.is_some());
}

#[test]
fn test_claim_locked_task_by_second_keeper_fails() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&first, &id);
    // Still inside the 120-ledger lock window.
    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::LockPeriodActive))
    );
}

#[test]
fn test_reclaim_after_lock_window_elapses() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&first, &id);
    // Move past the lock window (120 ledgers) but stay before the deadline.
    advance(&s.env, 121, 60);

    s.registry.claim_task(&second, &id);
    assert_eq!(s.registry.get_task(&id).claimer, Some(second));
}

#[test]
fn test_claim_past_deadline_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    advance(&s.env, 1, 3_601); // step past the 1-hour deadline
    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_claim_unknown_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_claim_task(&keeper, &999u64),
        Err(Ok(KeeperError::TaskNotFound))
    );
}

#[test]
fn test_execute_task_credits_keeper_net_of_fee() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // reward 1_000_000, fee 300 bps (3%)

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

    // 3% fee → keeper receives 970_000, contract retains 30_000 as fee.
    assert_eq!(s.registry.keeper_balance(&keeper), 970_000i128);
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Executed);
}

#[test]
fn test_execute_by_non_claimer_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let stranger = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    assert_eq!(
        s.registry
            .try_execute_task(&stranger, &id, &Bytes::from_slice(&s.env, b"x")),
        Err(Ok(KeeperError::NotTaskClaimer))
    );
}

#[test]
fn test_execute_unclaimed_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // still Pending

    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"x")),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

#[test]
fn test_execute_twice_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));
    // Second execution must fail — task is no longer Claimed.
    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p")),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

#[test]
fn test_execute_past_deadline_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    advance(&s.env, 1, 3_601); // deadline passes while claimed
    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p")),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
fn test_cancel_pending_task_refunds_owner() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let id = register_default_task(&s); // escrows 1_000_000
    assert_eq!(token.balance(&s.admin), before - 1_000_000i128);

    s.registry.cancel_task(&s.admin, &id);

    assert_eq!(token.balance(&s.admin), before); // fully refunded
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Cancelled);
}

#[test]
fn test_cancel_by_non_owner_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_cancel_task(&stranger, &id),
        Err(Ok(KeeperError::NotTaskOwner))
    );
}

#[test]
fn test_cancel_claimed_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    // Owner can no longer cancel once a keeper is working on it.
    assert_eq!(
        s.registry.try_cancel_task(&s.admin, &id),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

#[test]
fn test_expire_after_deadline_refunds_owner() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let token = token::Client::new(&s.env, &s.token_id);
    let before = token.balance(&s.admin);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id); // claimed but never executed

    advance(&s.env, 1, 3_601); // past deadline
                               // Permissionless: a third party can trigger the refund.
    s.registry.expire_task(&id);

    assert_eq!(token.balance(&s.admin), before); // owner made whole
    assert_eq!(s.registry.get_task(&id).status, TaskStatus::Expired);
}

#[test]
fn test_expire_before_deadline_fails() {
    let s = setup();
    let id = register_default_task(&s);
    assert_eq!(
        s.registry.try_expire_task(&id),
        Err(Ok(KeeperError::DeadlineNotPassed))
    );
}

#[test]
fn test_expire_executed_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));

    advance(&s.env, 1, 3_601);
    assert_eq!(
        s.registry.try_expire_task(&id),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// withdraw_rewards / sweep_fees
// ─────────────────────────────────────────────────────────────────────────────

/// Drives a full register → claim → execute cycle and returns the keeper.
fn executed_task_keeper(s: &Setup) -> Address {
    let keeper = Address::generate(&s.env);
    let id = register_default_task(s);
    s.registry.claim_task(&keeper, &id);
    s.registry
        .execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));
    keeper
}

#[test]
fn test_withdraw_transfers_balance_and_zeroes_it() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let keeper = executed_task_keeper(&s); // credited 970_000

    assert_eq!(token.balance(&keeper), 0i128);
    let withdrawn = s.registry.withdraw_rewards(&keeper);

    assert_eq!(withdrawn, 970_000i128);
    assert_eq!(token.balance(&keeper), 970_000i128);
    assert_eq!(s.registry.keeper_balance(&keeper), 0i128);
}

#[test]
fn test_withdraw_with_no_balance_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );
}

#[test]
fn test_double_withdraw_fails() {
    let s = setup();
    let keeper = executed_task_keeper(&s);
    s.registry.withdraw_rewards(&keeper);
    assert_eq!(
        s.registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );
}

#[test]
fn test_execute_accrues_protocol_fee() {
    let s = setup();
    let _ = executed_task_keeper(&s);
    // 3% of 1_000_000 withheld.
    assert_eq!(s.registry.fees_accrued(), 30_000i128);
}

#[test]
fn test_sweep_fees_to_treasury() {
    let s = setup();
    let token = token::Client::new(&s.env, &s.token_id);
    let _ = executed_task_keeper(&s); // 30_000 fee accrued
    let treasury = Address::generate(&s.env);

    s.registry.sweep_fees(&s.admin, &treasury, &30_000i128);

    assert_eq!(token.balance(&treasury), 30_000i128);
    assert_eq!(s.registry.fees_accrued(), 0i128);
}

#[test]
fn test_sweep_more_than_accrued_fails() {
    let s = setup();
    let _ = executed_task_keeper(&s); // 30_000 accrued
    let treasury = Address::generate(&s.env);
    // Guard: cannot sweep into task escrow / keeper balances.
    assert_eq!(
        s.registry.try_sweep_fees(&s.admin, &treasury, &30_001i128),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );
}

#[test]
fn test_sweep_by_non_admin_fails() {
    let s = setup();
    let _ = executed_task_keeper(&s);
    let stranger = Address::generate(&s.env);
    let treasury = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_sweep_fees(&stranger, &treasury, &1i128),
        Err(Ok(KeeperError::Unauthorized))
    );
}

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
            &17_280u32,
            &60u32,
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
            &17_280u32,
            &60u32,
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
        &17_280u32,
        &60u32,
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
    let before = s.env.events().all().len();
    s.registry.set_fee_bps(&s.admin, &500u32);
    assert!(s.env.events().all().len() > before);
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
    let new_admin = Address::generate(&s.env);
    let before = s.env.events().all().len();
    s.registry.transfer_admin(&s.admin, &new_admin);
    assert!(s.env.events().all().len() > before);
}

#[test]
fn test_upgrade_by_non_admin_fails() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    let bogus = soroban_sdk::BytesN::from_array(&s.env, &[0u8; 32]);
    assert_eq!(
        s.registry.try_upgrade(&stranger, &bogus),
        Err(Ok(KeeperError::Unauthorized))
    );
}
