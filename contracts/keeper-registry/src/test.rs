//! # KeeperRegistry — Starter Tests
//!
//! These tests cover the two functions that are currently implemented:
//! `initialize` and `register_task`.
//!
//! ## For contributors
//! When you implement a new function, add tests here.
//! Every public function must have at least:
//!   - one happy-path test
//!   - a test for each KeeperError variant it can return
//!
//! Run with: `cargo test --features testutils`

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token,
    Address, Bytes, Env,
};

use crate::{KeeperRegistry, KeeperRegistryClient, KeeperError, TaskStatus, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// Shared test setup
// ─────────────────────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    admin: Address,
    registry: KeeperRegistryClient<'static>,
    token_id: Address,
}

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
    Setup { env, admin, registry: unsafe { core::mem::transmute(registry) }, token_id }
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
    s.registry.execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof"));

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
        s.registry.try_execute_task(&stranger, &id, &Bytes::from_slice(&s.env, b"x")),
        Err(Ok(KeeperError::NotTaskClaimer))
    );
}

#[test]
fn test_execute_unclaimed_task_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s); // still Pending

    assert_eq!(
        s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"x")),
        Err(Ok(KeeperError::InvalidTaskStatus))
    );
}

#[test]
fn test_execute_twice_fails() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);

    s.registry.claim_task(&keeper, &id);
    s.registry.execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p"));
    // Second execution must fail — task is no longer Claimed.
    assert_eq!(
        s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p")),
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
        s.registry.try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"p")),
        Err(Ok(KeeperError::DeadlinePassed))
    );
}

#[test]
#[ignore = "implement cancel_task first — GitHub issue #3"]
fn test_cancel_task() {}

#[test]
#[ignore = "implement expire_task first — GitHub issue #4"]
fn test_expire_task() {}

#[test]
#[ignore = "implement withdraw_rewards first — GitHub issue #5"]
fn test_withdraw_rewards() {}
