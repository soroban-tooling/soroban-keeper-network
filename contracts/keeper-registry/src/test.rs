//! # KeeperRegistry — Unit & Integration Tests
//!
//! These tests use the `soroban-sdk` test environment (no network required).
//! Run with: `cargo test --features testutils`

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token,
    Address, Bytes, BytesN, Env,
};

use crate::{KeeperRegistry, KeeperRegistryClient, KeeperError, TaskStatus, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

struct TestSetup {
    env: Env,
    admin: Address,
    registry_id: Address,
    token_id: Address,
}

fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    // Deploy a native token (SAC) to use as reward currency
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let token = token::StellarAssetClient::new(&env, &token_id);

    // Mint tokens to admin so we can fund tasks
    token.mint(&admin, &1_000_000_000i128);

    // Deploy the registry contract
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin, &token_id, &300u32); // 3% fee

    TestSetup {
        env,
        admin,
        registry_id,
        token_id,
    }
}

fn default_calldata(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"liquidate:0xdeadbeef:1000")
}

fn advance_time(env: &Env, seconds: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current + seconds,
        protocol_version: env.ledger().protocol_version(),
        sequence_number: env.ledger().sequence() + (seconds / 5) as u32, // ~5s per ledger
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_307_200,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_success() {
    let TestSetup { env, admin, registry_id, token_id } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    assert_eq!(registry.admin(), Some(admin));
    assert_eq!(registry.get_fee_bps(), 300u32);
    assert!(!registry.is_paused());
    assert_eq!(registry.reward_token(), Some(token_id));
    assert_eq!(registry.task_count(), 0u64);
}

#[test]
fn test_initialize_already_initialized() {
    let TestSetup { env, admin, registry_id, token_id } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let result = registry.try_initialize(&admin, &token_id, &300u32);
    assert_eq!(result, Err(Ok(KeeperError::AlreadyInitialized)));
}

#[test]
fn test_initialize_invalid_fee_bps() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let registry_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let result = registry.try_initialize(&admin, &token_id, &10_001u32);
    assert_eq!(result, Err(Ok(KeeperError::InvalidFeeBps)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Task registration tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_register_task_success() {
    let TestSetup { env, admin, registry_id, token_id: _ } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let deadline = env.ledger().timestamp() + 3600; // 1 hour from now
    let task_id = registry.register_task(
        &admin,
        &TaskType::Liquidation,
        &default_calldata(&env),
        &1_000_000i128,
        &deadline,
        &17_280u32,  // ~1 day TTL
        &120u32,     // ~10 min lock
    );

    assert_eq!(task_id, 1u64);
    assert_eq!(registry.task_count(), 1u64);

    let task = registry.get_task(&task_id);
    assert_eq!(task.owner, admin);
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.reward, 1_000_000i128);
    assert_eq!(task.deadline, deadline);
}

#[test]
fn test_register_task_zero_reward_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let deadline = env.ledger().timestamp() + 3600;
    let result = registry.try_register_task(
        &admin,
        &TaskType::Custom,
        &default_calldata(&env),
        &0i128,
        &deadline,
        &17_280u32,
        &120u32,
    );
    assert_eq!(result, Err(Ok(KeeperError::InvalidReward)));
}

#[test]
fn test_register_task_past_deadline_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    // deadline in the past
    let deadline = env.ledger().timestamp().saturating_sub(1);
    let result = registry.try_register_task(
        &admin,
        &TaskType::Custom,
        &default_calldata(&env),
        &1_000_000i128,
        &deadline,
        &17_280u32,
        &120u32,
    );
    assert_eq!(result, Err(Ok(KeeperError::DeadlinePassed)));
}

#[test]
fn test_register_task_paused_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    registry.pause(&admin);

    let deadline = env.ledger().timestamp() + 3600;
    let result = registry.try_register_task(
        &admin,
        &TaskType::Custom,
        &default_calldata(&env),
        &1_000_000i128,
        &deadline,
        &17_280u32,
        &120u32,
    );
    assert_eq!(result, Err(Ok(KeeperError::ContractPaused)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim tests
// ─────────────────────────────────────────────────────────────────────────────

fn register_default_task(env: &Env, registry: &KeeperRegistryClient, owner: &Address) -> u64 {
    let deadline = env.ledger().timestamp() + 3600;
    registry.register_task(
        owner,
        &TaskType::Liquidation,
        &default_calldata(env),
        &1_000_000i128,
        &deadline,
        &17_280u32,
        &120u32,
    )
}

#[test]
fn test_claim_task_success() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper = Address::generate(&env);
    registry.claim_task(&keeper, &task_id);

    let task = registry.get_task(&task_id);
    assert_eq!(task.status, TaskStatus::Claimed);
    assert_eq!(task.claimer, Some(keeper));
}

#[test]
fn test_claim_nonexistent_task_fails() {
    let TestSetup { env, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let keeper = Address::generate(&env);

    let result = registry.try_claim_task(&keeper, &999u64);
    assert_eq!(result, Err(Ok(KeeperError::TaskNotFound)));
}

#[test]
fn test_claim_already_claimed_within_lock_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper1 = Address::generate(&env);
    let keeper2 = Address::generate(&env);
    registry.claim_task(&keeper1, &task_id);

    let result = registry.try_claim_task(&keeper2, &task_id);
    assert_eq!(result, Err(Ok(KeeperError::LockPeriodActive)));
}

#[test]
fn test_reclaim_after_lock_expires() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper1 = Address::generate(&env);
    let keeper2 = Address::generate(&env);
    registry.claim_task(&keeper1, &task_id);

    // Advance past the lock period (120 ledgers ≈ 600s)
    advance_time(&env, 700);

    registry.claim_task(&keeper2, &task_id);
    let task = registry.get_task(&task_id);
    assert_eq!(task.claimer, Some(keeper2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_execute_task_success_and_reward_credited() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper = Address::generate(&env);
    registry.claim_task(&keeper, &task_id);

    let proof = Bytes::from_slice(&env, b"0xabcdef123456");
    registry.execute_task(&keeper, &task_id, &proof);

    let task = registry.get_task(&task_id);
    assert_eq!(task.status, TaskStatus::Executed);

    // Net reward = 1_000_000 - 3% = 970_000
    let balance = registry.keeper_balance(&keeper);
    assert_eq!(balance, 970_000i128);
}

#[test]
fn test_execute_wrong_keeper_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper = Address::generate(&env);
    let interloper = Address::generate(&env);
    registry.claim_task(&keeper, &task_id);

    let proof = Bytes::from_slice(&env, b"0xdeadbeef");
    let result = registry.try_execute_task(&interloper, &task_id, &proof);
    assert_eq!(result, Err(Ok(KeeperError::NotTaskClaimer)));
}

#[test]
fn test_execute_unclaimed_task_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper = Address::generate(&env);
    let proof = Bytes::from_slice(&env, b"0xdeadbeef");
    let result = registry.try_execute_task(&keeper, &task_id, &proof);
    assert_eq!(result, Err(Ok(KeeperError::InvalidTaskStatus)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_cancel_task_refunds_owner() {
    let TestSetup { env, admin, registry_id, token_id } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let token = token::Client::new(&env, &token_id);

    let before = token.balance(&admin);
    let task_id = register_default_task(&env, &registry, &admin);
    let after_register = token.balance(&admin);
    assert_eq!(before - after_register, 1_000_000i128);

    registry.cancel_task(&admin, &task_id);

    let after_cancel = token.balance(&admin);
    assert_eq!(after_cancel, before); // full refund

    let task = registry.get_task(&task_id);
    assert_eq!(task.status, TaskStatus::Cancelled);
}

#[test]
fn test_cancel_not_owner_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let other = Address::generate(&env);
    let result = registry.try_cancel_task(&other, &task_id);
    assert_eq!(result, Err(Ok(KeeperError::NotTaskOwner)));
}

#[test]
fn test_cancel_claimed_task_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let keeper = Address::generate(&env);
    registry.claim_task(&keeper, &task_id);

    let result = registry.try_cancel_task(&admin, &task_id);
    assert_eq!(result, Err(Ok(KeeperError::InvalidTaskStatus)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Expire tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_expire_task_after_deadline() {
    let TestSetup { env, admin, registry_id, token_id } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let token = token::Client::new(&env, &token_id);

    let task_id = register_default_task(&env, &registry, &admin);
    let before_expire = token.balance(&admin);

    // Advance past deadline (1 hour = 3600s)
    advance_time(&env, 3601);

    registry.expire_task(&task_id);

    let after_expire = token.balance(&admin);
    assert_eq!(after_expire - before_expire, 1_000_000i128); // reward returned

    let task = registry.get_task(&task_id);
    assert_eq!(task.status, TaskStatus::Expired);
}

#[test]
fn test_expire_before_deadline_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let task_id = register_default_task(&env, &registry, &admin);

    let result = registry.try_expire_task(&task_id);
    assert_eq!(result, Err(Ok(KeeperError::DeadlineNotPassed)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdraw rewards tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_rewards_success() {
    let TestSetup { env, admin, registry_id, token_id } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let token = token::Client::new(&env, &token_id);

    let task_id = register_default_task(&env, &registry, &admin);
    let keeper = Address::generate(&env);
    registry.claim_task(&keeper, &task_id);
    registry.execute_task(&keeper, &task_id, &Bytes::from_slice(&env, b"proof"));

    let keeper_before = token.balance(&keeper);
    let withdrawn = registry.withdraw_rewards(&keeper);
    let keeper_after = token.balance(&keeper);

    assert_eq!(withdrawn, 970_000i128);
    assert_eq!(keeper_after - keeper_before, 970_000i128);
    assert_eq!(registry.keeper_balance(&keeper), 0i128);
}

#[test]
fn test_withdraw_no_rewards_fails() {
    let TestSetup { env, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let keeper = Address::generate(&env);

    let result = registry.try_withdraw_rewards(&keeper);
    assert_eq!(result, Err(Ok(KeeperError::NoRewardsAvailable)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_pause_unpause() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    registry.pause(&admin);
    assert!(registry.is_paused());

    registry.unpause(&admin);
    assert!(!registry.is_paused());
}

#[test]
fn test_pause_non_admin_fails() {
    let TestSetup { env, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let rando = Address::generate(&env);

    let result = registry.try_pause(&rando);
    assert_eq!(result, Err(Ok(KeeperError::Unauthorized)));
}

#[test]
fn test_set_fee_bps() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    registry.set_fee_bps(&admin, &500u32);
    assert_eq!(registry.get_fee_bps(), 500u32);
}

#[test]
fn test_set_fee_bps_over_limit_fails() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let result = registry.try_set_fee_bps(&admin, &10_001u32);
    assert_eq!(result, Err(Ok(KeeperError::InvalidFeeBps)));
}

#[test]
fn test_transfer_admin() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    let new_admin = Address::generate(&env);
    registry.transfer_admin(&admin, &new_admin);
    assert_eq!(registry.admin(), Some(new_admin.clone()));

    // Old admin can no longer pause
    let result = registry.try_pause(&admin);
    assert_eq!(result, Err(Ok(KeeperError::Unauthorized)));
}

#[test]
fn test_upgrade_wasm() {
    let TestSetup { env, admin, registry_id, .. } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);

    // Upload the same WASM as the "new" version for test purposes
    let new_wasm_hash: BytesN<32> = env
        .deployer()
        .upload_contract_wasm(KeeperRegistry::wasm(&env));

    // Should succeed — upgrade path is exercised
    registry.upgrade(&admin, &new_wasm_hash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-task scenario (integration-style)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_full_lifecycle_multiple_tasks() {
    let TestSetup { env, admin, registry_id, token_id } = setup();
    let registry = KeeperRegistryClient::new(&env, &registry_id);
    let token = token::Client::new(&env, &token_id);

    let keeper_a = Address::generate(&env);
    let keeper_b = Address::generate(&env);

    let deadline = env.ledger().timestamp() + 7200;

    // Task 1: liquidation — executed by keeper_a
    let t1 = registry.register_task(
        &admin, &TaskType::Liquidation, &default_calldata(&env),
        &2_000_000i128, &deadline, &17_280u32, &120u32,
    );
    registry.claim_task(&keeper_a, &t1);
    registry.execute_task(&keeper_a, &t1, &Bytes::from_slice(&env, b"tx_hash_1"));

    // Task 2: oracle push — cancelled by owner
    let t2 = registry.register_task(
        &admin, &TaskType::OraclePricePush, &default_calldata(&env),
        &500_000i128, &deadline, &17_280u32, &120u32,
    );
    registry.cancel_task(&admin, &t2);

    // Task 3: TTL extension — claimed by keeper_b, executed
    let t3 = registry.register_task(
        &admin, &TaskType::TtlExtension, &default_calldata(&env),
        &1_000_000i128, &deadline, &17_280u32, &120u32,
    );
    registry.claim_task(&keeper_b, &t3);
    registry.execute_task(&keeper_b, &t3, &Bytes::from_slice(&env, b"tx_hash_3"));

    // Verify task states
    assert_eq!(registry.get_task(&t1).status, TaskStatus::Executed);
    assert_eq!(registry.get_task(&t2).status, TaskStatus::Cancelled);
    assert_eq!(registry.get_task(&t3).status, TaskStatus::Executed);

    // Keeper A: 2_000_000 * 97% = 1_940_000
    assert_eq!(registry.keeper_balance(&keeper_a), 1_940_000i128);
    // Keeper B: 1_000_000 * 97% = 970_000
    assert_eq!(registry.keeper_balance(&keeper_b), 970_000i128);

    // Withdraw all
    let before_a = token.balance(&keeper_a);
    registry.withdraw_rewards(&keeper_a);
    assert_eq!(token.balance(&keeper_a) - before_a, 1_940_000i128);

    let before_b = token.balance(&keeper_b);
    registry.withdraw_rewards(&keeper_b);
    assert_eq!(token.balance(&keeper_b) - before_b, 970_000i128);

    assert_eq!(registry.task_count(), 3u64);
}
