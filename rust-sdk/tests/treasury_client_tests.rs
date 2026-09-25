//! Integration test for `TreasuryClient`, mirroring
//! `rust-sdk/tests/client_tests.rs`'s `test_client_initialization_and_admin`
//! / `test_batch_operations_and_queries` shape for the equivalent treasury
//! entry points and views.

use soroban_keeper_sdk::{KeypairSigner, TreasuryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_treasury_client_initialization_and_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(treasury::Treasury, ());
    let admin_addr = Address::generate(&env);
    let reward_token = Address::generate(&env);
    let signer = KeypairSigner::new(admin_addr.clone());

    let client = TreasuryClient::new(&env, contract_id.clone(), &signer);

    client
        .initialize(&reward_token)
        .expect("Failed to initialize");
    assert_eq!(client.admin(), Some(admin_addr.clone()));
    assert_eq!(client.reward_token_address(), Some(reward_token));

    client.pause().expect("Failed to pause");
    assert!(client.is_paused());
    client.unpause().expect("Failed to unpause");
    assert!(!client.is_paused());
}

#[test]
fn test_treasury_client_recipients_and_distribution() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(treasury::Treasury, ());
    let admin_addr = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(admin_addr.clone());
    let reward_token = token_contract.address();
    let signer = KeypairSigner::new(admin_addr.clone());

    soroban_sdk::token::StellarAssetClient::new(&env, &reward_token)
        .mint(&admin_addr, &100_000_000);

    let client = TreasuryClient::new(&env, contract_id.clone(), &signer);
    client
        .initialize(&reward_token)
        .expect("Failed to initialize");

    let recipient_addr = Address::generate(&env);
    client
        .add_recipient(&recipient_addr, 5_000)
        .expect("Failed to add recipient");

    let recipients = client.recipients();
    assert_eq!(recipients.len(), 1);
    assert_eq!(recipients.get(0).unwrap().shares_bps, 5_000u32);
    assert_eq!(client.recipient_shares(&recipient_addr), 5_000u32);

    client.distribute(1_000_000).expect("Failed to distribute");
    assert_eq!(client.recipient_balance(&recipient_addr), 1_000_000i128);
    assert_eq!(client.total_distributed(), 1_000_000i128);

    let recipient_signer = KeypairSigner::new(recipient_addr.clone());
    let recipient_client = TreasuryClient::new(&env, contract_id.clone(), &recipient_signer);
    let withdrawn = recipient_client.withdraw().expect("Failed to withdraw");
    assert_eq!(withdrawn, 1_000_000i128);
    assert_eq!(client.recipient_balance(&recipient_addr), 0i128);
}
