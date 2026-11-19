#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn test_detect_undercollateralized_and_liquidate() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MockLendingContract, ());
    let client = MockLendingContractClient::new(&env, &contract_id);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);

    // Borrower deposits 100 units of collateral @ $10/unit ($1000 collateral)
    // Borrows $600 debt with 150% minimum collateral ratio ($900 required collateral)
    client.open_position(&borrower, &100, &600, &10, &15000).unwrap();

    // Currently healthy: $1000 >= $900
    assert!(!client.is_liquidatable(&borrower));

    // Price drops to $8: collateral value becomes $800 < $900
    client.update_price(&borrower, &8).unwrap();
    assert!(client.is_liquidatable(&borrower));

    // Liquidator performs liquidation
    let seized = client.liquidate(&liquidator, &borrower).unwrap();
    assert_eq!(seized, 100);

    // Position is now liquidated
    assert!(!client.is_liquidatable(&borrower));
    let pos = client.get_position(&borrower).unwrap();
    assert!(pos.is_liquidated);
}

#[test]
fn test_healthy_position_cannot_be_liquidated() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MockLendingContract, ());
    let client = MockLendingContractClient::new(&env, &contract_id);
    let borrower = Address::generate(&env);
    let liquidator = Address::generate(&env);

    client.open_position(&borrower, &100, &500, &10, &15000).unwrap();
    assert!(!client.is_liquidatable(&borrower));

    let res = client.try_liquidate(&liquidator, &borrower);
    assert_eq!(res, Err(Ok(LendingError::PositionHealthy)));
}
