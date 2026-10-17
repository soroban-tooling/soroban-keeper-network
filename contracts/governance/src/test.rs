#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

struct TestSetup {
    env: Env,
    admin: Address,
    token_id: Address,
    client: GovernanceContractClient<'static>,
}

#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);

    client.initialize(&admin, &token_id);

    TestSetup {
        env: unsafe { core::mem::transmute(env) },
        admin,
        token_id,
        client: unsafe { core::mem::transmute(client) },
    }
}

#[test]
fn test_version_view_exposes_semantic_version() {
    let TestSetup { client, .. } = setup();
    assert_eq!(client.version(), 1u32);
}

#[test]
fn test_initialization_sets_admin_and_token() {
    let TestSetup {
        client,
        admin,
        token_id,
        ..
    } = setup();

    assert_eq!(client.admin(), admin);
    assert_eq!(client.kprs_token(), token_id);

    // Re-initialization must fail
    let res = client.try_initialize(&admin, &token_id);
    assert_eq!(res, Err(Ok(GovernanceError::AlreadyInitialized)));
}

#[test]
fn test_uninitialized_contract_rejects_queries() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);

    assert_eq!(client.version(), 1u32);
    assert_eq!(client.try_admin(), Err(Ok(GovernanceError::NotInitialized)));
    assert_eq!(client.try_kprs_token(), Err(Ok(GovernanceError::NotInitialized)));
    assert_eq!(
        client.try_get_voting_power(&user),
        Err(Ok(GovernanceError::NotInitialized))
    );
}

#[test]
fn test_voting_power_reads_from_kprs_token_contract() {
    let TestSetup {
        env,
        token_id,
        client,
        ..
    } = setup();

    let voter = Address::generate(&env);

    // Initial voting power is 0
    assert_eq!(client.get_voting_power(&voter), 0i128);

    // Mint tokens to voter and verify voting power reflects token balance
    let mint_amount = 5_000_000_000_000i128; // 500,000 KPRS
    token::StellarAssetClient::new(&env, &token_id).mint(&voter, &mint_amount);

    assert_eq!(client.get_voting_power(&voter), mint_amount);
}
