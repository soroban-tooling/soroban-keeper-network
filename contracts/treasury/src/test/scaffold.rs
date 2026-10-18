//! Scaffold tests verifying deployability, version view, and initial state
//! per acceptance criteria of issue #467.

use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{constants::VERSION, Treasury, TreasuryClient, TreasuryError};

#[test]
fn test_treasury_scaffold_deploy_and_version_convention() {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Contract deploys cleanly to a local test network environment
    let treasury_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &treasury_id);

    // 2. Exposes a version view following the registry's own VERSION convention (u32, VERSION = 1)
    assert_eq!(client.version(), VERSION);
    assert_eq!(client.version(), 1);

    // 3. Uninitialized state is clean and side-effect-free
    assert_eq!(client.admin(), None);
    assert_eq!(client.reward_token_address(), None);
    assert!(!client.is_paused());
    assert_eq!(client.recipients().len(), 0);
    assert_eq!(client.total_distributed(), 0i128);

    // Mutating entrypoints fail with NotInitialized before initialization
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let res = client.try_add_recipient(&admin, &recipient, &1000);
    assert_eq!(res, Err(Ok(TreasuryError::NotInitialized)));

    // 4. Initialize and verify configured scaffold
    let token = Address::generate(&env);
    client.initialize(&admin, &token);

    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.reward_token_address(), Some(token));
    assert!(!client.is_paused());
    assert_eq!(client.recipients().len(), 0);
}
