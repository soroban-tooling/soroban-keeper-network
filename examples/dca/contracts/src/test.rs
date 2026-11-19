#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

#[contract]
pub struct MockDcaRouter;

#[contractimpl]
impl MockDcaRouter {
    pub fn swap(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        recipient: Address,
    ) -> i128 {
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer_from(
            &env.current_contract_address(),
            &env.invoker(),
            &env.current_contract_address(),
            &amount_in,
        );

        // Simple mock rate 2x
        let out = amount_in * 2;
        if out < min_amount_out {
            panic!("Slippage exceeded");
        }

        let token_out_admin_client = StellarAssetClient::new(&env, &token_out);
        token_out_admin_client.mint(&recipient, &out);

        out
    }
}

#[test]
fn test_dca_fixed_amount_and_cancellation() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DcaContract, ());
    let client = DcaContractClient::new(&env, &contract_id);

    let owner = Address::generate(&env);

    // Mock tokens
    let token_in_admin = Address::generate(&env);
    let token_in_id = env.register_stellar_asset_contract_v2(token_in_admin.clone());
    let token_in_admin_client = StellarAssetClient::new(&env, &token_in_id.address());
    let token_in_client = TokenClient::new(&env, &token_in_id.address());

    let token_out_admin = Address::generate(&env);
    let token_out_id = env.register_stellar_asset_contract_v2(token_out_admin.clone());
    let token_out_client = TokenClient::new(&env, &token_out_id.address());

    let router_id = env.register(MockDcaRouter, ());

    // Mint 10,000 token_in to owner
    token_in_admin_client.mint(&owner, &10_000);

    env.ledger().set_sequence_number(1000);

    // Create plan: deposit 1,000, fixed swap 250 per period, interval 100 ledgers (4 total swaps)
    let plan_id = client.create_dca_plan(
        &owner,
        &token_in_id.address(),
        &token_out_id.address(),
        &1_000,
        &250, // fixed swap amount
        &100, // interval
        &router_id,
    );

    assert_eq!(token_in_client.balance(&owner), 9_000); // 1,000 deposited

    // 1. CRITERION 1: Swap 1 at ledger 1100 (exactly fixed 250 swapped)
    env.ledger().set_sequence_number(1100);
    let out1 = client.execute_dca_swap(&plan_id, &400);
    assert_eq!(out1, 500); // 250 * 2 = 500
    assert_eq!(token_out_client.balance(&owner), 500);

    let p1 = client.get_dca_plan(&plan_id);
    assert_eq!(p1.remaining_deposit, 750); // 1000 - 250
    assert_eq!(p1.total_swaps_executed, 1);

    // 2. CRITERION 2: Owner stops schedule by cancelling the plan
    let refunded = client.cancel_dca_plan(&owner, &plan_id);
    assert_eq!(refunded, 750); // exactly refunded the remaining 750 unswapped tokens!
    assert_eq!(token_in_client.balance(&owner), 9_750);

    let p_cancelled = client.get_dca_plan(&plan_id);
    assert_eq!(p_cancelled.status, DcaStatus::Cancelled);

    // Further swaps are rejected
    env.ledger().set_sequence_number(1200);
    let res_after = client.try_execute_dca_swap(&plan_id, &400);
    assert_eq!(
        res_after.unwrap_err().unwrap(),
        DcaError::PlanNotActive
    );
}
