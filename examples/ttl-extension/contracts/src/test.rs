#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

#[test]
fn test_initialization_and_storage_retrieval() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TtlExtensionContract, ());
    let client = TtlExtensionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.init(&admin, &42);

    assert_eq!(client.get_record(), 42);
    assert_eq!(client.get_extension_count(), 0);
}

#[test]
fn test_keeper_ttl_extension() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TtlExtensionContract, ());
    let client = TtlExtensionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.init(&admin, &100);

    // First keeper extension call
    let count1 = client.extend_ttl(&500, &5000);
    assert_eq!(count1, 1);
    assert_eq!(client.get_extension_count(), 1);

    // Second keeper extension call
    let count2 = client.extend_ttl(&1000, &10000);
    assert_eq!(count2, 2);
    assert_eq!(client.get_extension_count(), 2);

    // Verify storage remains fully readable and consistent
    assert_eq!(client.get_record(), 100);
}

#[test]
fn test_admin_update_record() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TtlExtensionContract, ());
    let client = TtlExtensionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.init(&admin, &100);
    client.set_record(&admin, &999);

    assert_eq!(client.get_record(), 999);
}

#[test]
#[should_panic]
fn test_invalid_ttl_params_rejects() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TtlExtensionContract, ());
    let client = TtlExtensionContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.init(&admin, &100);
    // threshold >= extend_to must fail
    client.extend_ttl(&5000, &5000);
}
