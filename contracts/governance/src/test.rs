#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _, token, Address, BytesN, Env, Symbol, Val, Vec,
};

#[allow(dead_code)]
struct TestContext {
    env: Env,
    admin: Address,
    token_id: Address,
    registry_id: Address,
    client: GovernanceContractClient<'static>,
    token_client: token::Client<'static>,
    token_admin_client: token::StellarAssetClient<'static>,
    eligible_proposer: Address,
}

fn setup() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_id = token_contract.address();
    let token_client = token::Client::new(&env, &token_id);
    let token_admin_client = token::StellarAssetClient::new(&env, &token_id);

    let registry_id = Address::generate(&env);

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &governance_id);
    client.initialize(&admin, &token_id, &registry_id);

    // Fund eligible proposer with exactly the proposal threshold
    let eligible_proposer = Address::generate(&env);
    token_admin_client.mint(&eligible_proposer, &DEFAULT_PROPOSAL_THRESHOLD);

    TestContext {
        env,
        admin,
        token_id,
        registry_id,
        client,
        token_client,
        token_admin_client,
        eligible_proposer,
    }
}

#[test]
fn test_version_view_and_initialization() {
    let TestContext {
        client,
        admin,
        token_id,
        registry_id,
        ..
    } = setup();

    assert_eq!(client.version(), 1u32);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.kprs_token(), token_id);
    assert_eq!(client.registry(), registry_id);
    assert_eq!(client.proposal_threshold(), DEFAULT_PROPOSAL_THRESHOLD);
    assert_eq!(client.voting_period(), DEFAULT_VOTING_PERIOD);
    assert_eq!(client.timelock_delay(), DEFAULT_TIMELOCK_DELAY);
    assert_eq!(client.quorum_bps(), DEFAULT_QUORUM_BPS);
    assert_eq!(client.proposal_count(), 0);

    // Re-initialization must fail
    let res = client.try_initialize(&admin, &token_id, &registry_id);
    assert_eq!(res, Err(Ok(GovernanceError::AlreadyInitialized)));
}

#[test]
fn test_create_proposal_enforces_minimum_holding_threshold() {
    let TestContext {
        env,
        client,
        token_admin_client,
        eligible_proposer,
        ..
    } = setup();

    let action = GovernableAction::SetFeeBps(400);

    // 1. Caller with 0 tokens fails
    let poor_caller = Address::generate(&env);
    let res = client.try_create_proposal(&poor_caller, &action);
    assert_eq!(res, Err(Ok(GovernanceError::InsufficientProposerBalance)));

    // 2. Caller with 1 unit below threshold fails
    let below_threshold_caller = Address::generate(&env);
    token_admin_client.mint(&below_threshold_caller, &(DEFAULT_PROPOSAL_THRESHOLD - 1));
    let res_below = client.try_create_proposal(&below_threshold_caller, &action);
    assert_eq!(res_below, Err(Ok(GovernanceError::InsufficientProposerBalance)));

    // 3. Caller with exactly the threshold succeeds
    let res_ok = client.create_proposal(&eligible_proposer, &action);
    assert_eq!(res_ok, 1u64);
    assert_eq!(client.proposal_count(), 1u64);

    let proposal = client.get_proposal(&1u64);
    assert_eq!(proposal.id, 1u64);
    assert_eq!(proposal.proposer, eligible_proposer);
    assert_eq!(proposal.action, action);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(proposal.votes_for, 0);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.votes_abstain, 0);
}

#[test]
fn test_every_enumerated_proposal_type_succeeds() {
    let TestContext {
        env,
        client,
        eligible_proposer,
        ..
    } = setup();

    let dummy_recipient = Address::generate(&env);
    let dummy_wasm_1 = BytesN::from_array(&env, &[1u8; 32]);
    let dummy_wasm_2 = BytesN::from_array(&env, &[2u8; 32]);

    let actions: [GovernableAction; 16] = [
        GovernableAction::SetFeeBps(350),
        GovernableAction::SetMinReward(500_000),
        GovernableAction::SetReputationFloor(800),
        GovernableAction::PauseRegistry,
        GovernableAction::UnpauseRegistry,
        GovernableAction::AddTreasuryRecipient(dummy_recipient.clone(), 1_500),
        GovernableAction::RemoveTreasuryRecipient(dummy_recipient.clone()),
        GovernableAction::UpdateTreasuryShares(dummy_recipient.clone(), 2_500),
        GovernableAction::PauseTreasury,
        GovernableAction::UnpauseTreasury,
        GovernableAction::SetVotingPeriod(60_000),
        GovernableAction::SetTimelockDelay(30_000),
        GovernableAction::SetQuorumBps(500),
        GovernableAction::SetProposalThreshold(150_000 * ONE_TOKEN),
        GovernableAction::UpgradeRegistry(dummy_wasm_1),
        GovernableAction::UpgradeTreasury(dummy_wasm_2),
    ];

    for (idx, action) in actions.into_iter().enumerate() {
        let expected_id = (idx as u64) + 1;
        let id = client.create_proposal(&eligible_proposer, &action);
        assert_eq!(id, expected_id);

        let proposal = client.get_proposal(&id);
        assert_eq!(proposal.id, expected_id);
        assert_eq!(proposal.action, action);
        assert_eq!(proposal.status, ProposalStatus::Active);
    }

    assert_eq!(client.proposal_count(), 16);
}

#[test]
fn test_parameter_boundary_validations_reject_invalid_values() {
    let TestContext {
        env,
        client,
        eligible_proposer,
        ..
    } = setup();

    let invalid_actions = [
        GovernableAction::SetFeeBps(10_001),
        GovernableAction::SetMinReward(-1),
        GovernableAction::SetReputationFloor(10_001),
        GovernableAction::AddTreasuryRecipient(Address::generate(&env), 0),
        GovernableAction::AddTreasuryRecipient(Address::generate(&env), 10_001),
        GovernableAction::UpdateTreasuryShares(Address::generate(&env), 0),
        GovernableAction::UpdateTreasuryShares(Address::generate(&env), 10_001),
        GovernableAction::SetVotingPeriod(10), // below 14_400
        GovernableAction::SetVotingPeriod(250_000), // above 201_600
        GovernableAction::SetTimelockDelay(100), // below 14_400
        GovernableAction::SetTimelockDelay(100_000), // above 86_400
        GovernableAction::SetQuorumBps(50), // below 100
        GovernableAction::SetQuorumBps(2_500), // above 2_000
        GovernableAction::SetProposalThreshold(-1),
    ];

    for invalid in invalid_actions {
        let res = client.try_create_proposal(&eligible_proposer, &invalid);
        assert_eq!(res, Err(Ok(GovernanceError::InvalidParameterValue)));
    }
}

#[test]
fn test_cannot_create_proposal_when_uninitialized() {
    let env = Env::default();
    env.mock_all_auths();

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &governance_id);

    let caller = Address::generate(&env);
    let action = GovernableAction::SetFeeBps(300);

    let res = client.try_create_proposal(&caller, &action);
    assert_eq!(res, Err(Ok(GovernanceError::NotInitialized)));
}

#[test]
fn test_non_enumerated_and_arbitrary_call_is_rejected() {
    let TestContext {
        env,
        client,
        eligible_proposer,
        ..
    } = setup();

    let arbitrary_fn = Symbol::new(&env, "create_proposal");
    let arbitrary_target = Address::generate(&env);
    let arbitrary_calldata = Symbol::new(&env, "transfer");

    let invalid_args: Vec<Val> = Vec::from_array(
        &env,
        [
            eligible_proposer.to_val(),
            arbitrary_target.to_val(),
            arbitrary_calldata.to_val(),
        ],
    );

    let res = env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &client.address,
        &arbitrary_fn,
        invalid_args,
    );

    assert!(res.is_err(), "non-enumerated or arbitrary call must be rejected");
}
