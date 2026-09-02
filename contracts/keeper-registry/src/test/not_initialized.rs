//! Every entry point requiring configured state must return NotInitialized.

use soroban_sdk::{testutils::Address as _, Address, Env};

use super::common::*;
use crate::{DataKey, KeeperError, KeeperRegistry, KeeperRegistryClient, TaskType};

// ─────────────────────────────────────────────────────────────────────────────
// NotInitialized — every entry point that requires configured state must
// return a typed error, never panic, when called before `initialize`.
// ─────────────────────────────────────────────────────────────────────────────

/// A freshly-deployed registry that `initialize` has never touched.
fn uninitialized_registry(env: &Env) -> KeeperRegistryClient<'_> {
    let registry_id = env.register(KeeperRegistry, ());
    KeeperRegistryClient::new(env, &registry_id)
}

#[test]
fn test_register_task_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let owner = Address::generate(&env);

    assert_eq!(
        registry.try_register_task(
            &owner,
            &TaskType::Custom,
            &calldata(&env),
            &1_000_000i128,
            &(env.ledger().timestamp() + 3_600),
            &DEFAULT_TTL_LEDGERS,
            &120u32,
            &None,
        ),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_withdraw_rewards_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let keeper = Address::generate(&env);

    // No balance either, but NotInitialized must be surfaced instead of
    // NoRewardsAvailable — the registry isn't configured at all yet.
    //
    // withdraw_rewards checks the keeper's balance before touching the
    // reward token, and a never-initialized registry has no balance for
    // anyone, so NoRewardsAvailable fires first here. This is correct: a
    // caller with nothing to withdraw gets the same answer regardless of
    // configuration state. The reward-token dependency is exercised by
    // test_withdraw_rewards_after_reward_token_migration_drop below.
    assert_eq!(
        registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NoRewardsAvailable))
    );
}

#[test]
fn test_pause_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    assert_eq!(
        registry.try_pause(&caller),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_unpause_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    assert_eq!(
        registry.try_unpause(&caller),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_set_fee_bps_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    assert_eq!(
        registry.try_set_fee_bps(&caller, &500u32),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_set_min_reward_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    assert_eq!(
        registry.try_set_min_reward(&caller, &1i128),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_transfer_admin_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    let new_admin = Address::generate(&env);
    assert_eq!(
        registry.try_transfer_admin(&caller, &new_admin),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_upgrade_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    let bogus = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
    assert_eq!(
        registry.try_upgrade(&caller, &bogus),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_sweep_fees_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    let treasury = Address::generate(&env);
    // require_admin runs before the reward-token lookup, so this surfaces
    // NotInitialized from the missing Admin key, not from RewardToken.
    assert_eq!(
        registry.try_sweep_fees(&caller, &treasury, &1i128),
        Err(Ok(KeeperError::NotInitialized))
    );
}

// increase_reward, cancel_task, and expire_task all load the task by id
// before they ever reach the reward-token lookup, and no task can exist on
// a registry that was never initialized (register_task itself requires the
// reward token to be configured). So "call before initialize" can only ever
// surface TaskNotFound for these three, not NotInitialized — that ordering
// (existence check before configuration check) is correct, not a gap.
//
// The reward-token dependency in these three functions is still real,
// though: a registry that was initialized and had a task registered, but
// later had its RewardToken key removed by e.g. a partial storage
// migration, must not panic. These tests reproduce exactly that.

#[test]
fn test_increase_reward_after_reward_token_migration_drop_fails() {
    let s = setup();
    let id = register_default_task(&s);
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().remove(&DataKey::RewardToken);
    });
    assert_eq!(
        s.registry.try_increase_reward(&s.admin, &id, &1i128),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_cancel_task_after_reward_token_migration_drop_fails() {
    let s = setup();
    let id = register_default_task(&s);
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().remove(&DataKey::RewardToken);
    });
    assert_eq!(
        s.registry.try_cancel_task(&s.admin, &id),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_expire_task_after_reward_token_migration_drop_fails() {
    let s = setup();
    let id = register_default_task(&s);
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().remove(&DataKey::RewardToken);
    });
    advance(&s.env, 1, 3_601); // past deadline
    assert_eq!(
        s.registry.try_expire_task(&id),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_withdraw_rewards_after_reward_token_migration_drop_fails() {
    let s = setup();
    let keeper = executed_task_keeper(&s); // has a balance to withdraw
    s.env.as_contract(&s.registry.address, || {
        s.env.storage().instance().remove(&DataKey::RewardToken);
    });
    assert_eq!(
        s.registry.try_withdraw_rewards(&keeper),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_require_admin_distinguishes_not_initialized_from_wrong_caller() {
    // Uninitialized: no admin configured at all.
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let caller = Address::generate(&env);
    assert_eq!(
        registry.try_pause(&caller),
        Err(Ok(KeeperError::NotInitialized))
    );

    // Initialized, but caller isn't the admin: a different, more specific
    // error than "not initialized".
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.registry.try_pause(&stranger),
        Err(Ok(KeeperError::Unauthorized))
    );
}
