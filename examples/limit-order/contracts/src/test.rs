#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

// Mock Condition Contract (implements ICondition)
#[contract]
pub struct MockPriceCondition;

#[contractimpl]
impl MockPriceCondition {
    pub fn set_met(env: Env, met: bool) {
        env.storage().instance().set(&symbol_short!("met"), &met);
    }

    pub fn check(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&symbol_short!("met"))
            .unwrap_or(false)
    }
}

// Mock DEX Router (implements IDexRouter)
#[contract]
pub struct MockDexRouter;

#[contractimpl]
impl MockDexRouter {
    pub fn set_output_rate(env: Env, rate_numerator: i128, rate_denominator: i128) {
        env.storage().instance().set(&symbol_short!("num"), &rate_numerator);
        env.storage().instance().set(&symbol_short!("den"), &rate_denominator);
    }

    pub fn swap(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        recipient: Address,
    ) -> i128 {
        let num: i128 = env.storage().instance().get(&symbol_short!("num")).unwrap_or(1);
        let den: i128 = env.storage().instance().get(&symbol_short!("den")).unwrap_or(1);

        let out_amount = (amount_in * num) / den;

        // Router checks slippage
        if out_amount < min_amount_out {
            panic!("Router: Slippage exceeded");
        }

        // Pull token_in from caller
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer_from(
            &env.current_contract_address(),
            &env.invoker(),
            &env.current_contract_address(),
            &amount_in,
        );

        // Send token_out to recipient
        let token_out_admin_client = StellarAssetClient::new(&env, &token_out);
        token_out_admin_client.mint(&recipient, &out_amount);

        out_amount
    }
}

#[test]
fn test_limit_order_execution_and_slippage_protection() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LimitOrderContract, ());
    let client = LimitOrderContractClient::new(&env, &contract_id);

    let creator = Address::generate(&env);

    // Mock tokens
    let token_in_admin = Address::generate(&env);
    let token_in_id = env.register_stellar_asset_contract_v2(token_in_admin.clone());
    let token_in_admin_client = StellarAssetClient::new(&env, &token_in_id.address());

    let token_out_admin = Address::generate(&env);
    let token_out_id = env.register_stellar_asset_contract_v2(token_out_admin.clone());
    let token_out_client = TokenClient::new(&env, &token_out_id.address());

    // Mint token_in to creator
    token_in_admin_client.mint(&creator, &1_000_000);

    // Mock Condition Contract
    let condition_id = env.register(MockPriceCondition, ());
    let condition_client = MockPriceConditionClient::new(&env, &condition_id);
    condition_client.set_met(&false); // initially false

    // Mock DEX Router
    let router_id = env.register(MockDexRouter, ());
    let router_client = MockDexRouterClient::new(&env, &router_id);
    router_client.set_output_rate(&10, &1); // default rate 10x

    // Create Order: 1,000 token_in -> min 9,500 token_out
    let order_id = client.create_order(
        &creator,
        &token_in_id.address(),
        &token_out_id.address(),
        &1_000,
        &9_500, // min_amount_out: must receive at least 9,500
        &10,    // target price
        &condition_id,
        &router_id,
    );

    // 1. CRITERION 1: Task uses on-chain price condition.
    // When condition is false, execution is rejected!
    let res_not_met = client.try_execute_order(&order_id);
    assert_eq!(
        res_not_met.unwrap_err().unwrap(),
        OrderError::PriceConditionNotMet
    );

    // 2. CRITERION 2: Slippage protection in swap call.
    // Price condition is satisfied, but DEX pool price slipped (rate = 8x, output = 8,000 < min 9,500)
    condition_client.set_met(&true);
    router_client.set_output_rate(&8, &1); // 8x < 9.5x threshold

    let res_slippage = client.try_execute_order(&order_id);
    assert!(res_slippage.is_err(), "Swap must fail when output violates slippage");

    // 3. Favorable price / acceptable slippage (rate = 10x, output = 10,000 >= min 9,500)
    router_client.set_output_rate(&10, &1);
    let out = client.execute_order(&order_id);
    assert_eq!(out, 10_000);
    assert_eq!(token_out_client.balance(&creator), 10_000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Filled);
}
