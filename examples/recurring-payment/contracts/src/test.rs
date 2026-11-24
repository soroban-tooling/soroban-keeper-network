#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};

#[test]
fn test_create_and_view_subscription() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(SubscriptionContract, ());
    let client = SubscriptionContractClient::new(&env, &contract_id);

    let subscriber = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    let id = client.create_subscription(&subscriber, &merchant, &token, &1000, &100, &12);
    assert_eq!(id, 1);

    let sub = client.get_subscription(&id);
    assert_eq!(sub.subscriber, subscriber);
    assert_eq!(sub.merchant, merchant);
    assert_eq!(sub.amount, 1000);
    assert_eq!(sub.interval_ledgers, 100);
    assert_eq!(sub.paid_periods, 0);
    assert_eq!(sub.active, true);
}

#[test]
fn test_refuse_double_payment_within_period() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(SubscriptionContract, ());
    let client = SubscriptionContractClient::new(&env, &contract_id);

    let subscriber = Address::generate(&env);
    let merchant = Address::generate(&env);

    // Mock token
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_admin_client = StellarAssetClient::new(&env, &token_id.address());
    let token_client = TokenClient::new(&env, &token_id.address());

    token_admin_client.mint(&subscriber, &50_000);

    // Set initial ledger sequence to 1000
    env.ledger().set_sequence_number(1000);

    let sub_id = client.create_subscription(
        &subscriber,
        &merchant,
        &token_id.address(),
        &500,
        &100, // interval = 100 ledgers
        &5,
    );

    // At ledger 1050 (< 1100), calling payment must fail with PaymentNotDueYet
    env.ledger().set_sequence_number(1050);
    let res_early = client.try_execute_payment(&sub_id);
    assert_eq!(
        res_early.unwrap_err().unwrap(),
        SubscriptionError::PaymentNotDueYet
    );

    // Advance to ledger 1100 (exactly interval boundary)
    env.ledger().set_sequence_number(1100);
    let period1 = client.execute_payment(&sub_id);
    assert_eq!(period1, 1);
    assert_eq!(token_client.balance(&merchant), 500);

    // CRITICAL: Calling payment again within the SAME period (at ledger 1100, 1150, 1199)
    // MUST BE REFUSED BY THE CONTRACT!
    let res_double = client.try_execute_payment(&sub_id);
    assert_eq!(
        res_double.unwrap_err().unwrap(),
        SubscriptionError::PaymentNotDueYet
    );

    env.ledger().set_sequence_number(1150);
    let res_double2 = client.try_execute_payment(&sub_id);
    assert_eq!(
        res_double2.unwrap_err().unwrap(),
        SubscriptionError::PaymentNotDueYet
    );

    // Advance to ledger 1200 -> period 2 succeeds!
    env.ledger().set_sequence_number(1200);
    let period2 = client.execute_payment(&sub_id);
    assert_eq!(period2, 2);
    assert_eq!(token_client.balance(&merchant), 1000);
}
