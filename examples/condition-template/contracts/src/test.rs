#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

#[test]
fn test_condition_met_when_threshold_reached() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ConditionTemplateContract, ());
    let client = ConditionTemplateContractClient::new(&env, &contract_id);
    let owner = Address::generate(&env);

    client.initialize(&owner).unwrap();

    let task_id = 101u64;
    client.set_task_threshold(&task_id, &1500);

    // Initial value is 0 (< 1500) -> false
    assert!(!client.is_met(&task_id));

    // Value increases to 1499 (< 1500) -> false
    client.update_metric_value(&task_id, &1499);
    assert!(!client.is_met(&task_id));

    // Value reaches 1500 (>= 1500) -> true
    client.update_metric_value(&task_id, &1500);
    assert!(client.is_met(&task_id));

    // Value exceeds 1500 (>= 1500) -> true
    client.update_metric_value(&task_id, &1800);
    assert!(client.is_met(&task_id));
}

#[test]
fn test_unconfigured_task_returns_false_safely() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(ConditionTemplateContract, ());
    let client = ConditionTemplateContractClient::new(&env, &contract_id);

    // No threshold set for task 999
    assert!(!client.is_met(&999u64));
}
