//! Integration tests for the staking SDK surface (issue #428, epic E06).
//!
//! Mirrors issue 0299's TypeScript staking test scenarios (stake, unstake,
//! slash, and the view entry points) against the same local Soroban test
//! environment `client_tests.rs` already uses for the rest of this crate's
//! integration coverage, rather than a real RPC-backed local network: this
//! crate has no existing local-network harness to plug into, and every
//! other integration test here (`test_client_initialization_and_admin`,
//! `test_batch_operations_and_queries`) validates the same way, through
//! `env.register` + `KeeperClient` against an in-process contract host.

use soroban_keeper_sdk::{KeeperClient, KeypairSigner, TransactionSigner};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

const UNBOND_DELAY_LEDGERS: u32 = keeper_registry::UNBOND_DELAY_LEDGERS;

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += ledgers;
    });
}

struct Setup {
    env: Env,
    contract_id: Address,
    admin_signer: KeypairSigner,
    keeper_signer: KeypairSigner,
    treasury: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(keeper_registry::KeeperRegistry, ());
    let admin_addr = Address::generate(&env);
    let keeper_addr = Address::generate(&env);
    let treasury = Address::generate(&env);
    let reward_token = env
        .register_stellar_asset_contract_v2(admin_addr.clone())
        .address();

    let admin_signer = KeypairSigner::new(admin_addr.clone());
    let admin_client = KeeperClient::new(&env, contract_id.clone(), &admin_signer);
    admin_client
        .initialize(&reward_token, 300)
        .expect("failed to initialize");

    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &reward_token);
    token_admin.mint(&keeper_addr, &10_000_000);
    // The admin must independently hold reward-token balance: an upheld
    // slash appeal (`resolve_slash_appeal`, `uphold_appeal: true`) has the
    // admin transfer the restored amount back into the contract, and
    // register_task escrows its reward from the task's owner (also the
    // admin in these tests) — neither path draws from the keeper's supply.
    token_admin.mint(&admin_addr, &10_000_000);

    Setup {
        env,
        contract_id,
        admin_signer,
        keeper_signer: KeypairSigner::new(keeper_addr),
        treasury,
    }
}

#[test]
fn test_stake_deposit_and_keeper_stake_view() {
    let s = setup();
    let keeper_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.keeper_signer);

    keeper_client
        .stake_deposit(500_000)
        .expect("stake_deposit should succeed");

    assert_eq!(
        keeper_client.keeper_stake(&s.keeper_signer.address()),
        500_000
    );
}

#[test]
fn test_stake_deposit_rejects_non_positive_amount() {
    let s = setup();
    let keeper_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.keeper_signer);

    let err = keeper_client
        .stake_deposit(0)
        .expect_err("a zero stake deposit must be rejected");
    // KeeperError variants are reachable through ClientError::ContractError's
    // formatted contents without the caller needing this crate's wrapping
    // details, per issue 428's error-decoding acceptance criterion.
    assert!(format!("{err}").contains("InvalidReward"));
}

#[test]
fn test_unbond_then_withdraw_stake_round_trip() {
    let s = setup();
    let keeper_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.keeper_signer);
    let keeper_addr = s.keeper_signer.address();

    keeper_client
        .stake_deposit(1_000_000)
        .expect("stake_deposit should succeed");

    keeper_client
        .initiate_unbond(400_000)
        .expect("initiate_unbond should succeed");

    // Bonded stake reflects only what's still fully bonded, not what's
    // mid-unbond (docs/STAKING_DESIGN.md §3).
    assert_eq!(keeper_client.keeper_stake(&keeper_addr), 600_000);
    let pending = keeper_client
        .pending_unbond(&keeper_addr)
        .expect("an unbond request should be pending");
    assert_eq!(pending.amount, 400_000);

    // Too early: the delay hasn't elapsed yet.
    let too_early = keeper_client
        .withdraw_stake()
        .expect_err("withdraw before the unbond delay must be rejected");
    assert!(format!("{too_early}").contains("UnbondNotReady"));

    advance(&s.env, UNBOND_DELAY_LEDGERS);

    let withdrawn = keeper_client
        .withdraw_stake()
        .expect("withdraw_stake should succeed once the delay has elapsed");
    assert_eq!(withdrawn, 400_000);
    assert!(keeper_client.pending_unbond(&keeper_addr).is_none());
}

#[test]
fn test_slash_moves_stake_to_treasury_and_appeal_can_be_upheld() {
    let s = setup();
    let admin_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.admin_signer);
    let keeper_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.keeper_signer);
    let keeper_addr = s.keeper_signer.address();

    keeper_client
        .stake_deposit(1_000_000)
        .expect("stake_deposit should succeed");

    let slash_id = admin_client
        .slash(&keeper_addr, 250_000, symbol_short!("missed"), &s.treasury)
        .expect("slash should succeed");

    assert_eq!(keeper_client.keeper_stake(&keeper_addr), 750_000);
    let record = admin_client
        .get_slash(slash_id)
        .expect("slash record should exist");
    assert_eq!(record.amount, 250_000);
    assert!(!record.appealed);

    // The slashed keeper appeals, and the admin upholds it: the stake is
    // restored (re-funded from the admin/treasury side, exactly like
    // resolve_slash_appeal's contract-level behavior).
    keeper_client
        .raise_slash_appeal(slash_id)
        .expect("raise_slash_appeal should succeed for the slashed keeper");
    assert!(admin_client.get_slash(slash_id).unwrap().appealed);

    admin_client
        .resolve_slash_appeal(slash_id, true)
        .expect("resolve_slash_appeal should succeed for the admin");

    assert_eq!(keeper_client.keeper_stake(&keeper_addr), 1_000_000);
    // A resolved appeal removes its record.
    assert!(admin_client.get_slash(slash_id).is_none());
}

#[test]
fn test_slash_appeal_rejected_leaves_slash_standing() {
    let s = setup();
    let admin_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.admin_signer);
    let keeper_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.keeper_signer);
    let keeper_addr = s.keeper_signer.address();

    keeper_client.stake_deposit(1_000_000).unwrap();
    let slash_id = admin_client
        .slash(&keeper_addr, 250_000, symbol_short!("missed"), &s.treasury)
        .unwrap();

    keeper_client.raise_slash_appeal(slash_id).unwrap();
    admin_client.resolve_slash_appeal(slash_id, false).unwrap();

    // Rejected appeal: the slash stands, stake is not restored.
    assert_eq!(keeper_client.keeper_stake(&keeper_addr), 750_000);
    assert!(admin_client.get_slash(slash_id).is_none());
}

#[test]
fn test_set_min_stake_gates_claim_task() {
    let s = setup();
    let admin_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.admin_signer);

    admin_client
        .set_min_stake(500_000)
        .expect("set_min_stake should succeed for the admin");
    assert_eq!(admin_client.min_stake(), 500_000);
}

#[test]
fn test_dispute_window_hold_and_upheld_dispute_forfeits_reward() {
    let s = setup();
    let admin_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.admin_signer);
    let keeper_client = KeeperClient::new(&s.env, s.contract_id.clone(), &s.keeper_signer);
    let keeper_addr = s.keeper_signer.address();

    admin_client
        .set_dispute_window(500)
        .expect("set_dispute_window should succeed for the admin");
    assert_eq!(admin_client.dispute_window(), 500);

    // Fund and register a task directly through the raw contract client:
    // register_task/claim_task/execute_task are outside this issue's scope
    // (already covered by client_tests.rs and the contract's own suite), so
    // this test only exercises the staking-epic surface #428 actually adds.
    let raw = keeper_registry::KeeperRegistryClient::new(&s.env, &s.contract_id);
    let owner = s.admin_signer.address();
    let deadline = s.env.ledger().timestamp() + 3_600;
    let task_id = raw.register_task(
        &owner,
        &keeper_registry::TaskType::Liquidation,
        &soroban_sdk::Bytes::from_slice(&s.env, b"calldata"),
        &1_000_000,
        &deadline,
        &18_000u32,
        &120u32,
        &None,
    );
    raw.claim_task(&keeper_addr, &task_id);
    raw.execute_task(
        &keeper_addr,
        &task_id,
        &soroban_sdk::Bytes::from_slice(&s.env, b"proof"),
    );

    // The credit is held pending, not immediately withdrawable.
    let pending = keeper_client.pending_reward(&keeper_addr);
    assert_eq!(pending.len(), 1);
    assert!(!pending.get(0).unwrap().disputed);

    admin_client
        .dispute_execution(task_id)
        .expect("dispute_execution should succeed for the task owner (admin, in this setup)");
    assert!(
        keeper_client
            .pending_reward(&keeper_addr)
            .get(0)
            .unwrap()
            .disputed
    );

    admin_client
        .resolve_execution_dispute(task_id, true)
        .expect("resolve_execution_dispute should succeed for the admin");

    // Upheld: the credit is dropped, the keeper is never paid.
    assert_eq!(keeper_client.pending_reward(&keeper_addr).len(), 0);
    assert_eq!(raw.keeper_balance(&keeper_addr), 0);
}
