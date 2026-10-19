//! Integration test for `GovernanceClient`, mirroring `TreasuryClient` and `KeeperClient` tests
//! and testing end-to-end lifecycle: initialize, proposal creation, voting, evaluating,
//! queueing, timelock wait, and execution.

use soroban_keeper_sdk::{
    GovernableAction, GovernanceClient, KeypairSigner, ProposalStatus, VoteChoice,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

#[soroban_sdk::contract]
pub struct MockRegistry;

#[soroban_sdk::contracttype]
#[derive(Clone)]
enum MockDataKey {
    Admin,
    FeeBps,
}

#[soroban_sdk::contractimpl]
impl MockRegistry {
    pub fn initialize(e: Env, admin: Address, _reward_token: Address, fee_bps: u32) {
        e.storage().instance().set(&MockDataKey::Admin, &admin);
        e.storage().instance().set(&MockDataKey::FeeBps, &fee_bps);
    }

    pub fn set_fee_bps(e: Env, admin: Address, new_bps: u32) {
        let current_admin: Address = e.storage().instance().get(&MockDataKey::Admin).unwrap();
        if admin != current_admin {
            panic!("unauthorized");
        }
        e.storage().instance().set(&MockDataKey::FeeBps, &new_bps);
    }

    pub fn set_min_reward(_e: Env, _admin: Address, _min_reward: i128) {}
    pub fn set_reputation_floor(_e: Env, _admin: Address, _floor_bps: u32) {}
    pub fn pause(_e: Env, _admin: Address) {}
    pub fn unpause(_e: Env, _admin: Address) {}
    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) {
        let current_admin: Address = e.storage().instance().get(&MockDataKey::Admin).unwrap();
        if admin != current_admin {
            panic!("unauthorized");
        }
        e.storage().instance().set(&MockDataKey::Admin, &new_admin);
    }
    pub fn upgrade(_e: Env, _admin: Address, _new_wasm_hash: BytesN<32>) {}

    pub fn get_fee_bps(e: Env) -> u32 {
        e.storage().instance().get(&MockDataKey::FeeBps).unwrap()
    }
}

#[test]
fn test_governance_client_lifecycle_e2e() {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.min_temp_entry_ttl = 50_000_000;
        li.min_persistent_entry_ttl = 50_000_000;
        li.max_entry_ttl = 50_000_000;
    });
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let voter = Address::generate(&env);
    let early_keepers = Address::generate(&env);
    let treasury_addr = Address::generate(&env);
    let core_team = Address::generate(&env);
    let public_dist = Address::generate(&env);

    let token_id = env.register(governance_token::GovernanceToken, ());
    let token_client = governance_token::GovernanceTokenClient::new(&env, &token_id);
    token_client.initialize(&admin, &early_keepers, &treasury_addr, &core_team, &public_dist);

    let reward_token = Address::generate(&env);
    let registry_id = env.register(MockRegistry, ());
    let mock_reg_client = MockRegistryClient::new(&env, &registry_id);
    mock_reg_client.initialize(&admin, &reward_token, &300u32);

    let governance_id = env.register(governance::GovernanceContract, ());
    mock_reg_client.transfer_admin(&admin, &governance_id);

    let admin_signer = KeypairSigner::new(admin.clone());
    let gov_client = GovernanceClient::new(&env, governance_id.clone(), &admin_signer);

    // Initialize governance
    gov_client
        .initialize(&token_id, &registry_id)
        .expect("Failed to initialize governance");

    assert_eq!(gov_client.admin(), admin);
    assert_eq!(gov_client.kprs_token(), token_id);
    assert_eq!(gov_client.registry(), registry_id);
    assert_eq!(gov_client.version(), 1);
    assert_eq!(gov_client.proposal_count(), 0);

    // Fund proposer with tokens above threshold
    let threshold = gov_client.proposal_threshold();
    token_client.transfer(&early_keepers, &voter, &(threshold + 1_000_000));

    let voter_signer = KeypairSigner::new(voter.clone());
    let voter_gov_client = GovernanceClient::new(&env, governance_id.clone(), &voter_signer);

    // Create proposal: SetFeeBps(500)
    let action = GovernableAction::SetFeeBps(500);
    let proposal_id = voter_gov_client
        .create_proposal(action)
        .expect("Failed to create proposal");
    assert_eq!(proposal_id, 1);
    assert_eq!(gov_client.proposal_count(), 1);

    let proposal = gov_client.get_proposal(proposal_id).expect("proposal exists");
    assert_eq!(proposal.status, ProposalStatus::Active);

    // Cast vote: For
    voter_gov_client
        .vote(proposal_id, VoteChoice::For)
        .expect("Failed to cast vote");

    assert!(gov_client.has_voted(proposal_id, &voter));
    let tallies = gov_client.get_tallies(proposal_id).expect("tallies");
    assert!(tallies.0 > 0); // votes_for > 0

    // Advance past voting period
    let voting_period = gov_client.voting_period();
    env.ledger().with_mut(|li| {
        li.sequence_number += voting_period + 1;
    });

    // Evaluate proposal
    let status = gov_client
        .evaluate_proposal(proposal_id)
        .expect("Failed to evaluate");
    assert_eq!(status, ProposalStatus::Passed);

    // Queue proposal
    let eta = gov_client
        .queue_proposal(proposal_id)
        .expect("Failed to queue");
    assert!(eta > 0);

    let queued_proposal = gov_client.get_proposal(proposal_id).expect("proposal exists");
    assert_eq!(queued_proposal.status, ProposalStatus::Queued);

    // Check before eta: not executable
    assert!(!gov_client.is_executable(proposal_id).expect("check executable"));

    // Advance ledger past eta
    let delay = gov_client.get_remaining_delay(proposal_id).expect("delay");
    env.ledger().with_mut(|li| {
        li.sequence_number += delay as u32 + 1;
    });
    assert!(gov_client.is_executable(proposal_id).expect("check executable"));

    // Execute proposal
    gov_client
        .execute_proposal(proposal_id)
        .expect("Failed to execute proposal");

    let executed_proposal = gov_client.get_proposal(proposal_id).expect("proposal exists");
    assert_eq!(executed_proposal.status, ProposalStatus::Executed);

    // Verify registry state updated
    assert_eq!(mock_reg_client.get_fee_bps(), 500u32);
}
