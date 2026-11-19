#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env};

#[test]
fn test_correct_proof_accepted() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(HashPreimageVerifier, ());
    let client = HashPreimageVerifierClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);

    client.initialize(&owner);

    let task_id = 42u64;
    let preimage = Bytes::from_slice(&env, b"secret_keeper_work_result_12345");
    let expected_hash = env.crypto().sha256(&preimage);

    // Owner sets the expected hash for this task
    client.set_expected_hash(&task_id, &expected_hash);

    // Verifier approves the correct proof
    let is_valid = client.verify(&task_id, &keeper, &preimage);
    assert!(is_valid);
}

#[test]
fn test_wrong_proof_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(HashPreimageVerifier, ());
    let client = HashPreimageVerifierClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);

    client.initialize(&owner);

    let task_id = 42u64;
    let preimage = Bytes::from_slice(&env, b"secret_keeper_work_result_12345");
    let wrong_preimage = Bytes::from_slice(&env, b"wrong_preimage_submitted_by_attacker");
    let expected_hash = env.crypto().sha256(&preimage);

    client.set_expected_hash(&task_id, &expected_hash);

    // Verifier rejects incorrect proof without panicking
    let is_valid = client.verify(&task_id, &keeper, &wrong_preimage);
    assert!(!is_valid);
}

#[test]
fn test_empty_proof_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(HashPreimageVerifier, ());
    let client = HashPreimageVerifierClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);

    client.initialize(&owner);

    let task_id = 42u64;
    let preimage = Bytes::from_slice(&env, b"some_data");
    let expected_hash = env.crypto().sha256(&preimage);

    client.set_expected_hash(&task_id, &expected_hash);

    // Verifier rejects empty proof
    let empty_proof = Bytes::new(&env);
    let is_valid = client.verify(&task_id, &keeper, &empty_proof);
    assert!(!is_valid);
}

#[test]
fn test_unregistered_task_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(HashPreimageVerifier, ());
    let client = HashPreimageVerifierClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);

    client.initialize(&owner);

    // No hash set for task 999
    let proof = Bytes::from_slice(&env, b"any_data");
    let is_valid = client.verify(&999u64, &keeper, &proof);
    assert!(!is_valid);
}
