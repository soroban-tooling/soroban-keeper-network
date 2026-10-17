//! Acceptance tests for `stake_deposit` / `keeper_stake` (issue #417).
//!
//! Runs the real keeper-registry contract in soroban's local test host. Each
//! test maps to one acceptance criterion: separate storage from
//! `KeeperReward`, the keeper's own auth, independence from task execution
//! and reward withdrawal, and the deposit event.

use keeper_registry::{KeeperError, KeeperRegistry, KeeperRegistryClient, TaskType};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, Env, IntoVal, Symbol, TryFromVal,
};

struct Setup<'a> {
    env: Env,
    registry: KeeperRegistryClient<'a>,
    token: TokenClient<'a>,
    admin: Address,
    keeper: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);

    let contract_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let keeper = Address::generate(&env);
    let token_addr = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let minter = StellarAssetClient::new(&env, &token_addr);
    minter.mint(&admin, &10_000_000);
    minter.mint(&keeper, &10_000_000);
    registry.initialize(&admin, &token_addr, &300);

    Setup {
        token: TokenClient::new(&env, &token_addr),
        env,
        registry,
        admin,
        keeper,
    }
}

#[test]
fn stake_is_escrowed_and_kept_apart_from_keeper_rewards() {
    let s = setup();
    let contract = s.registry.address.clone();
    let before = s.token.balance(&s.keeper);

    s.registry.stake_deposit(&s.keeper, &400_000);

    assert_eq!(s.registry.keeper_stake(&s.keeper), 400_000);
    // Stake lives under its own key: the reward balance is untouched.
    assert_eq!(s.registry.keeper_balance(&s.keeper), 0);
    assert_eq!(s.token.balance(&s.keeper), before - 400_000);
    assert_eq!(s.token.balance(&contract), 400_000);

    // Deposits accumulate.
    s.registry.stake_deposit(&s.keeper, &100_000);
    assert_eq!(s.registry.keeper_stake(&s.keeper), 500_000);
}

#[test]
fn stake_deposit_requires_the_depositing_keepers_own_auth() {
    let s = setup();
    s.registry.stake_deposit(&s.keeper, &1_000);

    // `mock_all_auths` records every require_auth the call made: the only
    // authorizing address for `stake_deposit` must be the keeper itself.
    let auths = s.env.auths();
    let (who, invocation) = auths.first().expect("stake_deposit must require auth");
    assert_eq!(who, &s.keeper);
    assert_eq!(
        invocation.function,
        soroban_sdk::testutils::AuthorizedFunction::Contract((
            s.registry.address.clone(),
            Symbol::new(&s.env, "stake_deposit"),
            (s.keeper.clone(), 1_000i128).into_val(&s.env),
        ))
    );
}

#[test]
fn stake_deposit_without_auth_is_rejected() {
    let env = Env::default();
    let contract_id = env.register(KeeperRegistry, ());
    let registry = KeeperRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    env.mock_all_auths();
    registry.initialize(&admin, &token, &300);
    StellarAssetClient::new(&env, &token).mint(&admin, &1_000);

    // Nobody else's auth is mocked any more: an address cannot stake on
    // another's behalf.
    env.set_auths(&[]);
    let victim = Address::generate(&env);
    assert!(registry.try_stake_deposit(&victim, &100).is_err());
    assert_eq!(registry.keeper_stake(&victim), 0);
}

#[test]
fn staking_executing_and_withdrawing_rewards_do_not_interfere() {
    let s = setup();
    let contract = s.registry.address.clone();

    s.registry.stake_deposit(&s.keeper, &300_000);

    let reward = 1_000_000i128;
    let id = s.registry.register_task(
        &s.admin,
        &TaskType::Custom,
        &Bytes::from_array(&s.env, &[1, 2, 3]),
        &reward,
        &(s.env.ledger().timestamp() + 1_000),
        &25_000,
        &20,
        &None,
        &None,
    );
    s.registry.claim_task(&s.keeper, &id);
    s.registry
        .execute_task(&s.keeper, &id, &Bytes::from_array(&s.env, &[9]));

    // Executing credited the reward balance and left the stake alone.
    let credited = s.registry.keeper_balance(&s.keeper);
    assert!(credited > 0);
    assert_eq!(s.registry.keeper_stake(&s.keeper), 300_000);

    // Withdrawing rewards pays out exactly the reward balance and leaves the
    // stake, and the escrowed stake tokens, alone.
    let before = s.token.balance(&s.keeper);
    let paid = s.registry.withdraw_rewards(&s.keeper);
    assert_eq!(paid, credited);
    assert_eq!(s.token.balance(&s.keeper), before + credited);
    assert_eq!(s.registry.keeper_balance(&s.keeper), 0);
    assert_eq!(s.registry.keeper_stake(&s.keeper), 300_000);
    // Contract still holds the stake (fees are accrued but not swept).
    assert!(s.token.balance(&contract) >= 300_000);

    // And a further deposit does not disturb the (now zero) reward balance.
    s.registry.stake_deposit(&s.keeper, &50_000);
    assert_eq!(s.registry.keeper_balance(&s.keeper), 0);
    assert_eq!(s.registry.keeper_stake(&s.keeper), 350_000);
}

#[test]
fn stake_deposit_emits_a_verb_noun_event_with_the_running_total() {
    let s = setup();
    let expected_topics = (symbol_short!("stkdep"), symbol_short!("stake")).into_val(&s.env);

    // `events().all()` reports the most recent invocation only, so check
    // after each deposit.
    for (amount, running_total) in [(100i128, 100i128), (50, 150)] {
        s.registry.stake_deposit(&s.keeper, &amount);
        let deposits: std::vec::Vec<_> = s
            .env
            .events()
            .all()
            .iter()
            .filter(|(c, t, _)| *c == s.registry.address && *t == expected_topics)
            .collect();
        assert_eq!(deposits.len(), 1);
        let (_, _, data) = &deposits[0];
        let payload = <(Address, i128, i128)>::try_from_val(&s.env, data).unwrap();
        assert_eq!(payload, (s.keeper.clone(), amount, running_total));
    }
}

#[test]
fn non_positive_deposit_is_rejected_and_leaves_no_stake() {
    let s = setup();
    for bad in [0i128, -5] {
        assert_eq!(
            s.registry.try_stake_deposit(&s.keeper, &bad),
            Err(Ok(KeeperError::InvalidReward))
        );
    }
    assert_eq!(s.registry.keeper_stake(&s.keeper), 0);
}
