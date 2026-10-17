//! Acceptance tests for the unbonding delay (issue #418).
//!
//! Runs the real keeper-registry contract in soroban's local test host:
//! stake requested for unbonding is not withdrawable before the delay,
//! boundary behaviour at delay-1 / exactly-at-delay / delay+1 (the same
//! discipline as the `lock_expired` tests), and stake that is mid-unbond no
//! longer counts as effective stake for the `claim_task` minimum-stake gate.

use keeper_registry::{
    KeeperError, KeeperRegistry, KeeperRegistryClient, TaskType, UNBOND_DELAY_LEDGERS,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, Env,
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

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

/// Stakes 1_000_000 and starts unbonding 400_000, returning the ledger the
/// request was made at.
fn unbonding(s: &Setup) -> u32 {
    s.registry.stake_deposit(&s.keeper, &1_000_000);
    s.registry.initiate_unbond(&s.keeper, &400_000);
    s.env.ledger().sequence()
}

#[test]
fn withdraw_one_ledger_before_the_delay_is_not_ready() {
    let s = setup();
    let start = unbonding(&s);
    s.env
        .ledger()
        .with_mut(|li| li.sequence_number = start + UNBOND_DELAY_LEDGERS - 1);

    let before = s.token.balance(&s.keeper);
    assert_eq!(
        s.registry.try_withdraw_stake(&s.keeper),
        Err(Ok(KeeperError::UnbondNotReady))
    );
    // Nothing moved, and the request is still pending.
    assert_eq!(s.token.balance(&s.keeper), before);
    assert!(s.registry.pending_unbond(&s.keeper).is_some());
}

#[test]
fn withdraw_exactly_at_the_delay_succeeds() {
    let s = setup();
    let start = unbonding(&s);
    s.env
        .ledger()
        .with_mut(|li| li.sequence_number = start + UNBOND_DELAY_LEDGERS);

    let before = s.token.balance(&s.keeper);
    assert_eq!(s.registry.withdraw_stake(&s.keeper), 400_000);
    assert_eq!(s.token.balance(&s.keeper), before + 400_000);
    assert!(s.registry.pending_unbond(&s.keeper).is_none());
    assert_eq!(s.registry.keeper_stake(&s.keeper), 600_000);
}

#[test]
fn withdraw_one_ledger_after_the_delay_succeeds() {
    let s = setup();
    let start = unbonding(&s);
    s.env
        .ledger()
        .with_mut(|li| li.sequence_number = start + UNBOND_DELAY_LEDGERS + 1);

    assert_eq!(s.registry.withdraw_stake(&s.keeper), 400_000);
    // A released request cannot be withdrawn twice.
    assert_eq!(
        s.registry.try_withdraw_stake(&s.keeper),
        Err(Ok(KeeperError::NoPendingUnbond))
    );
}

#[test]
fn unbonded_amount_leaves_effective_stake_immediately() {
    let s = setup();
    unbonding(&s);
    // Only the still-bonded part counts as the keeper's stake; the pending
    // request carries the rest, and the tokens stay escrowed until release.
    assert_eq!(s.registry.keeper_stake(&s.keeper), 600_000);
    assert_eq!(
        s.registry.pending_unbond(&s.keeper).unwrap().amount,
        400_000
    );
    assert_eq!(s.token.balance(&s.registry.address), 1_000_000);
}

#[test]
fn stake_mid_unbond_does_not_back_claim_task() {
    let s = setup();
    s.registry.set_min_stake(&s.admin, &500_000);
    s.registry.stake_deposit(&s.keeper, &600_000);

    let id = s.registry.register_task(
        &s.admin,
        &TaskType::Custom,
        &Bytes::from_array(&s.env, &[1]),
        &1_000_000,
        &(s.env.ledger().timestamp() + 1_000),
        &25_000,
        &20,
        &None,
        &None,
    );

    // Fully bonded: 600_000 >= 500_000. Unbond 200_000 and the effective
    // stake (400_000) falls below the floor, so claiming is refused even
    // though the keeper has deposited 600_000 in total.
    s.registry.initiate_unbond(&s.keeper, &200_000);
    assert_eq!(
        s.registry.try_claim_task(&s.keeper, &id),
        Err(Ok(KeeperError::MinStakeNotMet))
    );

    // Topping the effective stake back up restores eligibility.
    s.registry.stake_deposit(&s.keeper, &100_000);
    s.registry.claim_task(&s.keeper, &id);
}

#[test]
fn only_one_request_may_be_pending_and_it_cannot_exceed_the_stake() {
    let s = setup();
    s.registry.stake_deposit(&s.keeper, &1_000);

    assert_eq!(
        s.registry.try_initiate_unbond(&s.keeper, &1_001),
        Err(Ok(KeeperError::InsufficientStake))
    );
    assert_eq!(
        s.registry.try_initiate_unbond(&s.keeper, &0),
        Err(Ok(KeeperError::InvalidReward))
    );

    s.registry.initiate_unbond(&s.keeper, &300);
    assert_eq!(
        s.registry.try_initiate_unbond(&s.keeper, &100),
        Err(Ok(KeeperError::UnbondAlreadyPending))
    );
    // The first request is untouched by the rejected second one.
    assert_eq!(s.registry.pending_unbond(&s.keeper).unwrap().amount, 300);
}

#[test]
fn withdraw_without_a_request_is_rejected() {
    let s = setup();
    s.registry.stake_deposit(&s.keeper, &1_000);
    advance(&s.env, UNBOND_DELAY_LEDGERS + 1);
    assert_eq!(
        s.registry.try_withdraw_stake(&s.keeper),
        Err(Ok(KeeperError::NoPendingUnbond))
    );
}
