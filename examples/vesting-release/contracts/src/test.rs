#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};

#[test]
fn test_vesting_cliff_and_tranche_boundaries() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(VestingContract, ());
    let client = VestingContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    // Mock token
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_admin_client = StellarAssetClient::new(&env, &token_id.address());
    let token_client = TokenClient::new(&env, &token_id.address());

    // Mint 12,000 tokens (e.g. 1,000 per month for 12 months)
    token_admin_client.mint(&sender, &12_000);

    let start_time = 1_000_000u64;
    let tranche_interval = 30 * 86400u64; // 30 days per tranche
    let cliff_time = start_time + 6 * tranche_interval; // 6-month cliff (180 days)
    let num_tranches = 12u32;

    env.ledger().set_timestamp(start_time);

    client.initialize(
        &sender,
        &beneficiary,
        &token_id.address(),
        &12_000,
        &start_time,
        &cliff_time,
        &num_tranches,
        &tranche_interval,
    );

    // 1. REFUSAL BEFORE CLIFF
    // At Day 90 (halfway through cliff): contract MUST refuse release!
    env.ledger().set_timestamp(start_time + 3 * tranche_interval);
    let res_early = client.try_release();
    assert_eq!(
        res_early.unwrap_err().unwrap(),
        VestingError::CliffNotReached
    );
    assert_eq!(token_client.balance(&beneficiary), 0);

    // 2. CLIFF BOUNDARY (Month 6)
    // At cliff time, 6 tranches (50% = 6,000 tokens) unlock in one release
    env.ledger().set_timestamp(cliff_time);
    let cliff_release = client.release();
    assert_eq!(cliff_release, 6_000);
    assert_eq!(token_client.balance(&beneficiary), 6_000);

    // 3. REFUSAL BETWEEN TRANCHES
    // Day 195 (15 days after cliff, before Month 7 tranche):
    // Calling release again must be refused!
    env.ledger().set_timestamp(cliff_time + 15 * 86400);
    let res_mid = client.try_release();
    assert_eq!(
        res_mid.unwrap_err().unwrap(),
        VestingError::TrancheNotReached
    );

    // 4. TRANCHE 7 BOUNDARY (Month 7)
    env.ledger().set_timestamp(start_time + 7 * tranche_interval);
    let tranche7 = client.release();
    assert_eq!(tranche7, 1_000);
    assert_eq!(token_client.balance(&beneficiary), 7_000);

    // 5. TRANCHE 8 - 12 BOUNDARIES
    for tranche in 8..=12 {
        env.ledger().set_timestamp(start_time + (tranche as u64) * tranche_interval);
        let amount = client.release();
        assert_eq!(amount, 1_000);
    }
    assert_eq!(token_client.balance(&beneficiary), 12_000);

    // 6. AFTER 100% VESTING
    env.ledger().set_timestamp(start_time + 15 * tranche_interval);
    let res_finished = client.try_release();
    assert_eq!(
        res_finished.unwrap_err().unwrap(),
        VestingError::AllVestedAlready
    );
}
