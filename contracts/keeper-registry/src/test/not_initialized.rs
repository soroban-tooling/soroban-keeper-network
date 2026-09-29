//! Every entry point requiring configured state must return NotInitialized.

use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

use super::common::*;
use crate::reputation::{record_missed_claim, stored_record};
use crate::{
    DataKey, KeeperError, KeeperRegistry, KeeperRegistryClient, ReputationRecord, TaskType,
};

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

// ─────────────────────────────────────────────────────────────────────────────
// Reputation-affecting entry points (issue 0333)
//
// Reputation is updated inside claim_task (a missed claim for the previous
// claimer on an expired-lock takeover) and execute_task (a success for the
// executing keeper) rather than through new entry points. These tests pin
// that the guards those functions ran before the reputation layer was added
// still run first and still surface the same error, and that a rejected call
// never writes reputation.
//
// Neither function reads configured state (they have never touched Admin,
// RewardToken, or FeeBps before their first write), so on a never-initialized
// registry they surface TaskNotFound — no task can exist before initialize —
// exactly as `fuzz_targets/uninitialized_registry.rs` has always asserted.
// That result is what must stay unchanged; the same existence-before-
// configuration ordering is explained for increase_reward, cancel_task, and
// expire_task above.
//
// The registry has no reputation eligibility floor (docs/REPUTATION_DESIGN.md
// keeps claim_task permissionless), so a keeper with a poor record is used
// wherever a floor would bite: if one is ever added, these tests fail unless
// it runs after the initialization and pause checks.
// ─────────────────────────────────────────────────────────────────────────────

fn reputation_of(
    env: &Env,
    registry: &KeeperRegistryClient<'_>,
    keeper: &Address,
) -> ReputationRecord {
    env.as_contract(&registry.address, || stored_record(env, keeper))
}

/// Gives `keeper` a record of one missed claim and no successes (score 0),
/// the worst standing a keeper can have.
fn with_missed_claim(
    env: &Env,
    registry: &KeeperRegistryClient<'_>,
    keeper: &Address,
) -> ReputationRecord {
    env.as_contract(&registry.address, || record_missed_claim(env, keeper));
    let record = reputation_of(env, registry, keeper);
    assert_eq!(record.missed_claims, 1);
    assert_eq!(record.score_bps, 0);
    record
}

#[test]
fn test_claim_task_before_init_fails_without_touching_reputation() {
// Staking entry points (epic E06) — the same discipline the original entry
// points already have, extended to stake_deposit, initiate_unbond,
// withdraw_stake, and slash. See docs/STAKING_DESIGN.md.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_stake_deposit_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let keeper = Address::generate(&env);

    assert_eq!(
        registry.try_claim_task(&keeper, &0u64),
        Err(Ok(KeeperError::TaskNotFound))
    );
    assert_eq!(
        reputation_of(&env, &registry, &keeper),
        ReputationRecord::zero()
        registry.try_stake_deposit(&keeper, &100i128),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_execute_task_before_init_fails_without_touching_reputation() {
fn test_initiate_unbond_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let keeper = Address::generate(&env);

    assert_eq!(
        registry.try_execute_task(&keeper, &0u64, &Bytes::from_slice(&env, b"proof")),
        Err(Ok(KeeperError::TaskNotFound))
    );
    // The proof-length check has always run before the task lookup.
    assert_eq!(
        registry.try_execute_task(
            &keeper,
            &0u64,
            &Bytes::from_slice(&env, &[0u8; (crate::MAX_PROOF_LEN + 1) as usize]),
        ),
        Err(Ok(KeeperError::ProofTooLarge))
    );
    assert_eq!(
        reputation_of(&env, &registry, &keeper),
        ReputationRecord::zero()
    // Without the explicit NotInitialized check, this would otherwise
    // surface InsufficientStake (an uninitialized registry has no stake for
    // anyone) — a misleading answer for a registry that was never
    // configured at all.
    assert_eq!(
        registry.try_initiate_unbond(&keeper, &50i128),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_claim_task_before_init_ignores_existing_reputation() {
    // A record already in storage (e.g. left by a partial migration) must not
    // change what an uninitialized registry reports, nor be updated by it.
fn test_withdraw_stake_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let keeper = Address::generate(&env);
    let before = with_missed_claim(&env, &registry, &keeper);

    assert_eq!(
        registry.try_claim_task(&keeper, &0u64),
        Err(Ok(KeeperError::TaskNotFound))
    );
    assert_eq!(
        registry.try_execute_task(&keeper, &0u64, &Bytes::from_slice(&env, b"proof")),
        Err(Ok(KeeperError::TaskNotFound))
    );
    assert_eq!(reputation_of(&env, &registry, &keeper), before);
}

#[test]
fn test_claim_task_while_paused_reports_paused_for_low_reputation_keeper() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let before = with_missed_claim(&s.env, &s.registry, &keeper);
    let id = register_default_task(&s);
    s.registry.pause(&s.admin);

    assert_eq!(
        s.registry.try_claim_task(&keeper, &id),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(reputation_of(&s.env, &s.registry, &keeper), before);

    // Unpausing restores normal claiming: reputation alone never rejects it.
    s.registry.unpause(&s.admin);
    s.registry.claim_task(&keeper, &id);
}

#[test]
fn test_takeover_while_paused_does_not_record_missed_claim() {
    // The takeover path is the one place claim_task writes reputation for a
    // keeper other than the caller. A paused takeover must be rejected before
    // that write, so the original claimer is not penalized for a claim that
    // never happened.
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);
    let (id, unlock_at) = claim_with_lock(&s, &first, 120);
    goto_ledger(&s.env, unlock_at);
    s.registry.pause(&s.admin);

    assert_eq!(
        s.registry.try_claim_task(&second, &id),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(
        reputation_of(&s.env, &s.registry, &first),
        ReputationRecord::zero()
    );
    assert_eq!(
        reputation_of(&s.env, &s.registry, &second),
        ReputationRecord::zero()
    );

    // Once unpaused the same takeover succeeds and records the miss.
    s.registry.unpause(&s.admin);
    s.registry.claim_task(&second, &id);
    assert_eq!(reputation_of(&s.env, &s.registry, &first).missed_claims, 1);
}

#[test]
fn test_execute_task_while_paused_does_not_record_success() {
    let s = setup();
    let keeper = Address::generate(&s.env);
    let id = register_default_task(&s);
    s.registry.claim_task(&keeper, &id);
    s.registry.pause(&s.admin);

    assert_eq!(
        s.registry
            .try_execute_task(&keeper, &id, &Bytes::from_slice(&s.env, b"proof")),
        Err(Ok(KeeperError::ContractPaused))
    );
    assert_eq!(
        reputation_of(&s.env, &s.registry, &keeper),
        ReputationRecord::zero()
    );

    // Without the explicit NotInitialized check, this would otherwise
    // surface NoPendingUnbond — technically true, but not the most useful
    // answer for a registry that was never configured at all.
    assert_eq!(
        registry.try_withdraw_stake(&keeper),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_slash_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let admin = Address::generate(&env);
    let keeper = Address::generate(&env);
    let treasury = Address::generate(&env);

    assert_eq!(
        registry.try_slash(&admin, &keeper, &100i128, &symbol_short!("bad"), &treasury),
        Err(Ok(KeeperError::NotInitialized))
    );
}

#[test]
fn test_stake_deposit_before_init_writes_no_state() {
    // Regression guard for the ordering bug this issue's fix corrects:
    // stake_deposit used to write the updated KeeperStake balance to
    // persistent storage *before* discovering (via reward_token) that the
    // registry was never initialized, leaving a stray balance behind for a
    // contract that should have no state at all. require_initialized now
    // runs first, so the call fails before touching storage.
    let env = Env::default();
    env.mock_all_auths();
    let registry = uninitialized_registry(&env);
    let keeper = Address::generate(&env);

    let _ = registry.try_stake_deposit(&keeper, &100i128);

    env.as_contract(&registry.address, || {
        assert!(!env
            .storage()
            .persistent()
            .has(&DataKey::KeeperStake(keeper)));
    });
}
