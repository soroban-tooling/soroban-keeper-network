#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, Symbol, Val, Vec,
};

#[allow(dead_code)]
struct TestContext {
    env: Env,
    admin: Address,
    token_id: Address,
    registry_id: Address,
    client: GovernanceContractClient<'static>,
    token_client: governance_token::GovernanceTokenClient<'static>,
    early_keepers: Address,
    eligible_proposer: Address,
}

fn setup() -> TestContext {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let early_keepers = Address::generate(&env);
    let treasury = Address::generate(&env);
    let core_team = Address::generate(&env);
    let public_dist = Address::generate(&env);

    let token_id = env.register(governance_token::GovernanceToken, ());
    let token_client = governance_token::GovernanceTokenClient::new(&env, &token_id);
    token_client.initialize(&admin, &early_keepers, &treasury, &core_team, &public_dist);

    let registry_id = Address::generate(&env);

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &governance_id);
    client.initialize(&admin, &token_id, &registry_id);

    // Fund eligible proposer with exactly the proposal threshold
    let eligible_proposer = Address::generate(&env);
    token_client.transfer(&early_keepers, &eligible_proposer, &DEFAULT_PROPOSAL_THRESHOLD);

    TestContext {
        env,
        admin,
        token_id,
        registry_id,
        client,
        token_client,
        early_keepers,
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
        token_client,
        early_keepers,
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
    token_client.transfer(
        &early_keepers,
        &below_threshold_caller,
        &(DEFAULT_PROPOSAL_THRESHOLD - 1),
    );
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

#[test]
fn test_voting_power_fixed_at_proposal_creation_and_unaffected_by_mid_vote_transfers() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    // 1. Setup voter accounts at ledger 100
    env.ledger().set_sequence_number(100);

    let voter_1 = Address::generate(&env);
    let voter_2 = Address::generate(&env);

    let voter_1_initial = 1_000_000 * ONE_TOKEN;
    let voter_2_initial = 500_000 * ONE_TOKEN;

    token_client.transfer(&early_keepers, &voter_1, &voter_1_initial);
    token_client.transfer(&early_keepers, &voter_2, &voter_2_initial);

    // 2. Create proposal at ledger 100
    let action = GovernableAction::SetFeeBps(250);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    assert_eq!(proposal_id, 1);

    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.created_at, 100);

    // 3. Advance to ledger 150: Voter 1 transfers 600,000 KPRS to Voter 2 mid-vote
    env.ledger().set_sequence_number(150);
    let transfer_amount = 600_000 * ONE_TOKEN;
    token_client.transfer(&voter_1, &voter_2, &transfer_amount);

    // Live balances reflect the transfer
    assert_eq!(token_client.balance(&voter_1), 400_000 * ONE_TOKEN);
    assert_eq!(token_client.balance(&voter_2), 1_100_000 * ONE_TOKEN);

    // But historical snapshot power at proposal creation (ledger 100) is unchanged
    assert_eq!(client.get_voting_power_at(&voter_1, &100), voter_1_initial);
    assert_eq!(client.get_voting_power_at(&voter_2, &100), voter_2_initial);

    // 4. Voter 1 casts vote FOR at ledger 160
    env.ledger().set_sequence_number(160);
    client.vote(&voter_1, &proposal_id, &VoteChoice::For);

    // Voter 1's vote is weighted by snapshot balance (1,000,000), not live balance (400,000)
    let vote_record_1 = client.get_vote(&proposal_id, &voter_1).unwrap();
    assert_eq!(vote_record_1.choice, VoteChoice::For);
    assert_eq!(vote_record_1.weight, voter_1_initial);

    // 5. Voter 2 casts vote AGAINST at ledger 170
    env.ledger().set_sequence_number(170);
    client.vote(&voter_2, &proposal_id, &VoteChoice::Against);

    // Voter 2's vote is weighted by snapshot balance (500,000), not live balance (1,100,000)
    let vote_record_2 = client.get_vote(&proposal_id, &voter_2).unwrap();
    assert_eq!(vote_record_2.choice, VoteChoice::Against);
    assert_eq!(vote_record_2.weight, voter_2_initial);

    // 6. Check proposal tallies
    let (votes_for, votes_against, votes_abstain) = client.get_tallies(&proposal_id);
    assert_eq!(votes_for, voter_1_initial);
    assert_eq!(votes_against, voter_2_initial);
    assert_eq!(votes_abstain, 0);

    // 7. Advance ledger further and do another transfer to confirm already-cast votes remain fixed
    env.ledger().set_sequence_number(200);
    token_client.transfer(&voter_2, &voter_1, &(200_000 * ONE_TOKEN));
    let (final_for, final_against, final_abstain) = client.get_tallies(&proposal_id);
    assert_eq!(final_for, voter_1_initial);
    assert_eq!(final_against, voter_2_initial);
    assert_eq!(final_abstain, 0);
}

#[test]
fn test_voter_cannot_vote_twice() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);
    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(50_000 * ONE_TOKEN));

    let action = GovernableAction::PauseRegistry;
    let proposal_id = client.create_proposal(&eligible_proposer, &action);

    // First vote succeeds
    client.vote(&voter, &proposal_id, &VoteChoice::For);
    assert!(client.has_voted(&proposal_id, &voter));

    // Second vote must fail with AlreadyVoted
    let res = client.try_vote(&voter, &proposal_id, &VoteChoice::Against);
    assert_eq!(res, Err(Ok(GovernanceError::AlreadyVoted)));
}

#[test]
fn test_tallies_queryable_before_voting_period_closes() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter_for = Address::generate(&env);
    let voter_against = Address::generate(&env);
    let voter_abstain = Address::generate(&env);

    token_client.transfer(&early_keepers, &voter_for, &(300_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_against, &(150_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_abstain, &(50_000 * ONE_TOKEN));

    let action = GovernableAction::SetQuorumBps(600);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);

    // Active voting period is 100..=50,500
    env.ledger().set_sequence_number(1_000);
    client.vote(&voter_for, &proposal_id, &VoteChoice::For);
    client.vote(&voter_against, &proposal_id, &VoteChoice::Against);
    client.vote(&voter_abstain, &proposal_id, &VoteChoice::Abstain);

    // Query tallies while voting is still active
    let (f, a, ab) = client.get_tallies(&proposal_id);
    assert_eq!(f, 300_000 * ONE_TOKEN);
    assert_eq!(a, 150_000 * ONE_TOKEN);
    assert_eq!(ab, 50_000 * ONE_TOKEN);

    // Proposal struct also reflects identical tallies
    let prop = client.get_proposal(&proposal_id);
    assert_eq!(prop.votes_for, 300_000 * ONE_TOKEN);
    assert_eq!(prop.votes_against, 150_000 * ONE_TOKEN);
    assert_eq!(prop.votes_abstain, 50_000 * ONE_TOKEN);
}

#[test]
fn test_cannot_vote_after_voting_period_ends() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);
    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(100_000 * ONE_TOKEN));

    let action = GovernableAction::UnpauseRegistry;
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    let proposal = client.get_proposal(&proposal_id);

    // Advance past voting_end
    env.ledger().set_sequence_number((proposal.voting_end as u32) + 1);

    let res = client.try_vote(&voter, &proposal_id, &VoteChoice::For);
    assert_eq!(res, Err(Ok(GovernanceError::VotingEnded)));
}

#[test]
fn test_cannot_vote_with_zero_power() {
    let TestContext {
        env,
        client,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);
    let zero_balance_voter = Address::generate(&env);

    let action = GovernableAction::SetFeeBps(100);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);

    let res = client.try_vote(&zero_balance_voter, &proposal_id, &VoteChoice::For);
    assert_eq!(res, Err(Ok(GovernanceError::InsufficientVotingPower)));
}

#[test]
fn test_proposal_fails_when_below_quorum_regardless_of_lopsided_votes() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter_for = Address::generate(&env);
    // 500,000 KPRS is 100% of the cast votes, but far below the 4% quorum (4,000,000 KPRS)
    let votes_cast = 500_000 * ONE_TOKEN;
    token_client.transfer(&early_keepers, &voter_for, &votes_cast);

    let action = GovernableAction::SetFeeBps(200);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    let proposal = client.get_proposal(&proposal_id);

    // Voter casts 100% of votes FOR
    client.vote(&voter_for, &proposal_id, &VoteChoice::For);

    // Verify while voting is active, cannot evaluate
    let err_active = client.try_evaluate_proposal(&proposal_id);
    assert_eq!(err_active, Err(Ok(GovernanceError::VotingStillActive)));

    // Advance past voting_end
    env.ledger().set_sequence_number((proposal.voting_end as u32) + 1);

    // Public state checks
    assert_eq!(client.is_quorum_met(&proposal_id), false);
    assert_eq!(client.is_passing_threshold_met(&proposal_id), true);
    assert_eq!(
        client.get_proposal_status(&proposal_id),
        ProposalStatus::Defeated
    );

    // Final evaluation transitions to Defeated due to quorum failure
    let final_status = client.evaluate_proposal(&proposal_id);
    assert_eq!(final_status, ProposalStatus::Defeated);

    let defeated_prop = client.get_proposal(&proposal_id);
    assert_eq!(defeated_prop.status, ProposalStatus::Defeated);
}

#[test]
fn test_proposal_meeting_quorum_but_below_passing_threshold_fails() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter_for = Address::generate(&env);
    let voter_against = Address::generate(&env);

    // Total participating votes: 2.0M + 3.0M = 5.0M KPRS (meets 4.0M quorum)
    token_client.transfer(&early_keepers, &voter_for, &(2_000_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_against, &(3_000_000 * ONE_TOKEN));

    let action = GovernableAction::SetMinReward(10_000);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    let proposal = client.get_proposal(&proposal_id);

    client.vote(&voter_for, &proposal_id, &VoteChoice::For);
    client.vote(&voter_against, &proposal_id, &VoteChoice::Against);

    // Advance past voting_end
    env.ledger().set_sequence_number((proposal.voting_end as u32) + 1);

    assert_eq!(client.is_quorum_met(&proposal_id), true);
    assert_eq!(client.is_passing_threshold_met(&proposal_id), false);
    assert_eq!(
        client.get_proposal_status(&proposal_id),
        ProposalStatus::Defeated
    );

    let final_status = client.evaluate_proposal(&proposal_id);
    assert_eq!(final_status, ProposalStatus::Defeated);
}

#[test]
fn test_proposal_tied_votes_meeting_quorum_fails() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter_for = Address::generate(&env);
    let voter_against = Address::generate(&env);

    // Exact tie: 2.5M vs 2.5M (total 5.0M meets quorum)
    token_client.transfer(&early_keepers, &voter_for, &(2_500_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_against, &(2_500_000 * ONE_TOKEN));

    let action = GovernableAction::SetReputationFloor(600);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    let proposal = client.get_proposal(&proposal_id);

    client.vote(&voter_for, &proposal_id, &VoteChoice::For);
    client.vote(&voter_against, &proposal_id, &VoteChoice::Against);

    env.ledger().set_sequence_number((proposal.voting_end as u32) + 1);

    assert_eq!(client.is_quorum_met(&proposal_id), true);
    assert_eq!(client.is_passing_threshold_met(&proposal_id), false);

    let final_status = client.evaluate_proposal(&proposal_id);
    assert_eq!(final_status, ProposalStatus::Defeated);
}

#[test]
fn test_proposal_meeting_both_quorum_and_passing_threshold_passes() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter_for = Address::generate(&env);
    let voter_against = Address::generate(&env);
    let voter_abstain = Address::generate(&env);

    // 4.5M For, 1.0M Against, 0.5M Abstain = 6.0M total (meets 4.0M quorum)
    token_client.transfer(&early_keepers, &voter_for, &(4_500_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_against, &(1_000_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_abstain, &(500_000 * ONE_TOKEN));

    let action = GovernableAction::SetFeeBps(300);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    let proposal = client.get_proposal(&proposal_id);

    client.vote(&voter_for, &proposal_id, &VoteChoice::For);
    client.vote(&voter_against, &proposal_id, &VoteChoice::Against);
    client.vote(&voter_abstain, &proposal_id, &VoteChoice::Abstain);

    env.ledger().set_sequence_number((proposal.voting_end as u32) + 1);

    // Meets both criteria
    assert_eq!(client.is_quorum_met(&proposal_id), true);
    assert_eq!(client.is_passing_threshold_met(&proposal_id), true);
    assert_eq!(
        client.get_proposal_status(&proposal_id),
        ProposalStatus::Passed
    );

    let final_status = client.evaluate_proposal(&proposal_id);
    assert_eq!(final_status, ProposalStatus::Passed);

    let passed_prop = client.get_proposal(&proposal_id);
    assert_eq!(passed_prop.status, ProposalStatus::Passed);
}

#[test]
fn test_deterministic_evaluation_by_any_observer_from_public_state() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(4_200_000 * ONE_TOKEN));

    let action = GovernableAction::PauseTreasury;
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    client.vote(&voter, &proposal_id, &VoteChoice::For);

    // Any observer can read public parameters and compute outcome
    let total_supply = client.total_token_supply();
    let quorum_bps = client.quorum_bps();
    let quorum_thresh = client.quorum_threshold();
    assert_eq!(total_supply, 100_000_000 * ONE_TOKEN);
    assert_eq!(quorum_bps, 400); // 4%
    assert_eq!(quorum_thresh, 4_000_000 * ONE_TOKEN);

    let (f, a, ab) = client.get_tallies(&proposal_id);
    let total_votes = f + a + ab;
    assert_eq!(total_votes >= quorum_thresh, true);
    assert_eq!(f > a, true);

    // Observer query matches contract status check exactly
    let proposal = client.get_proposal(&proposal_id);
    env.ledger().set_sequence_number((proposal.voting_end as u32) + 1);

    assert_eq!(
        client.get_proposal_status(&proposal_id),
        ProposalStatus::Passed
    );
}

#[test]
fn test_timelock_delay_boundary_checks_and_execution() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(5_000_000 * ONE_TOKEN));

    // Proposal 1: Action SetFeeBps(250)
    let action_1 = GovernableAction::SetFeeBps(250);
    let proposal_1 = client.create_proposal(&eligible_proposer, &action_1);
    client.vote(&voter, &proposal_1, &VoteChoice::For);

    let prop_1 = client.get_proposal(&proposal_1);
    // Advance to voting end + 1 (50_501)
    env.ledger().set_sequence_number((prop_1.voting_end as u32) + 1);

    // Queue proposal 1: delay is DEFAULT_TIMELOCK_DELAY (28_800 ledgers)
    let eta_1 = client.queue_proposal(&proposal_1);
    assert_eq!(eta_1, 50_501 + 28_800);

    // 1. Boundary: delay-minus-one (eta_1 - 1 = 79_300)
    env.ledger().set_sequence_number((eta_1 as u32) - 1);
    assert_eq!(client.is_executable(&proposal_1), false);
    assert_eq!(client.get_remaining_delay(&proposal_1), 1);

    let err_early = client.try_execute_proposal(&proposal_1);
    assert_eq!(err_early, Err(Ok(GovernanceError::TimelockNotElapsed)));

    // 2. Boundary: exactly-at-delay (eta_1 = 79_301)
    env.ledger().set_sequence_number(eta_1 as u32);
    assert_eq!(client.is_executable(&proposal_1), true);
    assert_eq!(client.get_remaining_delay(&proposal_1), 0);

    let exec_res = client.execute_proposal(&proposal_1);
    assert_eq!(exec_res, ());

    let executed_prop = client.get_proposal(&proposal_1);
    assert_eq!(executed_prop.status, ProposalStatus::Executed);

    // 3. Boundary: delay-plus-one (for a new proposal)
    let action_2 = GovernableAction::SetMinReward(20_000);
    let proposal_2 = client.create_proposal(&eligible_proposer, &action_2);
    client.vote(&voter, &proposal_2, &VoteChoice::For);

    let prop_2 = client.get_proposal(&proposal_2);
    env.ledger().set_sequence_number((prop_2.voting_end as u32) + 1);
    let eta_2 = client.queue_proposal(&proposal_2);

    // Advance to eta_2 + 1
    env.ledger().set_sequence_number((eta_2 as u32) + 1);
    assert_eq!(client.is_executable(&proposal_2), true);
    assert_eq!(client.get_remaining_delay(&proposal_2), 0);

    client.execute_proposal(&proposal_2);
    assert_eq!(
        client.get_proposal(&proposal_2).status,
        ProposalStatus::Executed
    );
}

#[test]
fn test_queued_state_and_remaining_delay_are_queryable() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(4_500_000 * ONE_TOKEN));

    let action = GovernableAction::PauseRegistry;
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    client.vote(&voter, &proposal_id, &VoteChoice::For);

    let prop = client.get_proposal(&proposal_id);
    env.ledger().set_sequence_number((prop.voting_end as u32) + 1);

    // Prior to queuing, query fails with ProposalNotQueued
    assert_eq!(
        client.try_get_remaining_delay(&proposal_id),
        Err(Ok(GovernanceError::ProposalNotQueued))
    );

    let queue_ledger = (prop.voting_end as u32) + 1;
    let eta = client.queue_proposal(&proposal_id);

    // Once queued, affected parties can inspect the queued status and exact remaining delay
    let queued_prop = client.get_proposal(&proposal_id);
    assert_eq!(queued_prop.status, ProposalStatus::Queued);
    assert_eq!(queued_prop.eta, eta);

    // At queue ledger, remaining delay equals full delay
    assert_eq!(
        client.get_remaining_delay(&proposal_id),
        DEFAULT_TIMELOCK_DELAY as u64
    );
    assert_eq!(client.is_executable(&proposal_id), false);

    // Advance 10,000 ledgers into the delay
    env.ledger().set_sequence_number(queue_ledger + 10_000);
    assert_eq!(
        client.get_remaining_delay(&proposal_id),
        (DEFAULT_TIMELOCK_DELAY - 10_000) as u64
    );
    assert_eq!(client.is_executable(&proposal_id), false);
}

#[test]
fn test_timelock_cannot_be_bypassed_by_fast_track_proposal_or_other_actions() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(10_000_000 * ONE_TOKEN));

    // Proposal 1: Critical action (e.g., pause treasury)
    let action_1 = GovernableAction::PauseTreasury;
    let prop_1_id = client.create_proposal(&eligible_proposer, &action_1);
    client.vote(&voter, &prop_1_id, &VoteChoice::For);

    let prop_1 = client.get_proposal(&prop_1_id);
    env.ledger().set_sequence_number((prop_1.voting_end as u32) + 1);
    let eta_1 = client.queue_proposal(&prop_1_id);

    // Attempted fast-track: Create Proposal 2 attempting to shorten the timelock delay
    let action_2 = GovernableAction::SetTimelockDelay(14_400); // 1 day instead of 2 days
    let prop_2_id = client.create_proposal(&eligible_proposer, &action_2);
    client.vote(&voter, &prop_2_id, &VoteChoice::For);

    // Even if ledger advances to 65_000 (after 14_400 ledgers would have elapsed from queueing):
    // Proposal 1's eta was fixed at queue time and cannot be shortened or bypassed!
    env.ledger().set_sequence_number(65_000);
    assert!(65_000 < eta_1);

    let res = client.try_execute_proposal(&prop_1_id);
    assert_eq!(res, Err(Ok(GovernanceError::TimelockNotElapsed)));

    // Furthermore, an unqueued proposal cannot be executed directly
    let action_3 = GovernableAction::SetFeeBps(100);
    let prop_3_id = client.create_proposal(&eligible_proposer, &action_3);
    let unqueued_err = client.try_execute_proposal(&prop_3_id);
    assert_eq!(unqueued_err, Err(Ok(GovernanceError::ProposalNotQueued)));
}

#[test]
fn test_cannot_execute_proposal_twice() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(5_000_000 * ONE_TOKEN));

    let action = GovernableAction::SetVotingPeriod(72_000);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);
    client.vote(&voter, &proposal_id, &VoteChoice::For);

    let prop = client.get_proposal(&proposal_id);
    env.ledger().set_sequence_number((prop.voting_end as u32) + 1);
    let eta = client.queue_proposal(&proposal_id);

    env.ledger().set_sequence_number(eta as u32);
    client.execute_proposal(&proposal_id);

    // Verify parameter was updated by execution
    assert_eq!(client.voting_period(), 72_000);

    // Second execution must fail with ProposalAlreadyExecuted
    let res = client.try_execute_proposal(&proposal_id);
    assert_eq!(res, Err(Ok(GovernanceError::ProposalAlreadyExecuted)));
}

#[test]
fn test_read_only_views_at_all_lifecycle_stages() {
    let TestContext {
        env,
        client,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter_for = Address::generate(&env);
    let voter_against = Address::generate(&env);
    let voter_abstain = Address::generate(&env);

    // Quorum is 4% of 100M = 4M KPRS.
    // Give voter_for 3M, voter_against 1M, voter_abstain 1M -> total 5M KPRS (quorum met, for > against).
    token_client.transfer(&early_keepers, &voter_for, &(3_000_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_against, &(1_000_000 * ONE_TOKEN));
    token_client.transfer(&early_keepers, &voter_abstain, &(1_000_000 * ONE_TOKEN));

    let action = GovernableAction::SetFeeBps(250);
    let proposal_id = client.create_proposal(&eligible_proposer, &action);

    // 1. Initial stage: Active, no votes cast
    let prop = client.get_proposal(&proposal_id);
    assert_eq!(prop.id, proposal_id);
    assert_eq!(prop.proposer, eligible_proposer);
    assert_eq!(prop.action, action);
    assert_eq!(prop.status, ProposalStatus::Active);
    assert_eq!(client.get_proposal_status(&proposal_id), ProposalStatus::Active);
    assert_eq!(client.get_proposal_state(&proposal_id), ProposalStatus::Active);

    assert_eq!(client.get_tallies(&proposal_id), (0, 0, 0));
    assert_eq!(client.is_quorum_met(&proposal_id), false);
    assert_eq!(client.is_passing_threshold_met(&proposal_id), false);
    assert_eq!(client.is_executable(&proposal_id), false);
    assert_eq!(client.try_get_remaining_delay(&proposal_id), Err(Ok(GovernanceError::ProposalNotQueued)));

    // 2. Voting in progress: vote For, Against, Abstain
    client.vote(&voter_for, &proposal_id, &VoteChoice::For);
    assert_eq!(client.has_voted(&proposal_id, &voter_for), true);
    assert_eq!(client.has_voted(&proposal_id, &voter_against), false);
    assert_eq!(
        client.get_vote(&proposal_id, &voter_for),
        Some(VoteRecord { choice: VoteChoice::For, weight: 3_000_000 * ONE_TOKEN })
    );
    assert_eq!(client.is_passing_threshold_met(&proposal_id), true);
    // Quorum (4M) not met with only 3M:
    assert_eq!(client.is_quorum_met(&proposal_id), false);

    client.vote(&voter_against, &proposal_id, &VoteChoice::Against);
    client.vote(&voter_abstain, &proposal_id, &VoteChoice::Abstain);

    let tallies = client.get_tallies(&proposal_id);
    assert_eq!(tallies, (3_000_000 * ONE_TOKEN, 1_000_000 * ONE_TOKEN, 1_000_000 * ONE_TOKEN));
    assert_eq!(client.is_quorum_met(&proposal_id), true);
    assert_eq!(client.is_passing_threshold_met(&proposal_id), true);
    assert_eq!(client.get_proposal_status(&proposal_id), ProposalStatus::Active);
    assert_eq!(client.get_proposal_state(&proposal_id), ProposalStatus::Active);

    // 3. Voting period ended (passed but not yet queued)
    env.ledger().set_sequence_number((prop.voting_end as u32) + 1);
    assert_eq!(client.get_proposal_status(&proposal_id), ProposalStatus::Passed);
    assert_eq!(client.get_proposal_state(&proposal_id), ProposalStatus::Passed);
    assert_eq!(client.is_executable(&proposal_id), false);

    // 4. Queued stage
    let eta = client.queue_proposal(&proposal_id);
    let prop_queued = client.get_proposal(&proposal_id);
    assert_eq!(prop_queued.status, ProposalStatus::Queued);
    assert_eq!(prop_queued.eta, eta);
    assert_eq!(client.get_proposal_status(&proposal_id), ProposalStatus::Queued);
    assert_eq!(client.get_proposal_state(&proposal_id), ProposalStatus::Queued);
    assert_eq!(client.is_executable(&proposal_id), false);

    let remaining = client.get_remaining_delay(&proposal_id);
    assert_eq!(remaining, eta - ((prop.voting_end as u64) + 1));

    // 5. Timelock elapsed: executable
    env.ledger().set_sequence_number(eta as u32);
    assert_eq!(client.get_remaining_delay(&proposal_id), 0);
    assert_eq!(client.is_executable(&proposal_id), true);
    assert_eq!(client.get_proposal_status(&proposal_id), ProposalStatus::Queued);
    assert_eq!(client.get_proposal_state(&proposal_id), ProposalStatus::Queued);

    // 6. Executed stage
    client.execute_proposal(&proposal_id);
    let prop_executed = client.get_proposal(&proposal_id);
    assert_eq!(prop_executed.status, ProposalStatus::Executed);
    assert_eq!(client.get_proposal_status(&proposal_id), ProposalStatus::Executed);
    assert_eq!(client.get_proposal_state(&proposal_id), ProposalStatus::Executed);
    assert_eq!(client.is_executable(&proposal_id), false);
    assert_eq!(client.try_get_remaining_delay(&proposal_id), Err(Ok(GovernanceError::ProposalNotQueued)));

    // 7. Failed/Defeated proposal lifecycle
    let action_fail = GovernableAction::SetFeeBps(300);
    let prop_fail_id = client.create_proposal(&eligible_proposer, &action_fail);
    let prop_fail = client.get_proposal(&prop_fail_id);

    // Vote against with 5M KPRS
    client.vote(&voter_for, &prop_fail_id, &VoteChoice::Against);
    client.vote(&voter_against, &prop_fail_id, &VoteChoice::Against);
    client.vote(&voter_abstain, &prop_fail_id, &VoteChoice::Against);

    env.ledger().set_sequence_number((prop_fail.voting_end as u32) + 1);
    assert_eq!(client.is_quorum_met(&prop_fail_id), true);
    assert_eq!(client.is_passing_threshold_met(&prop_fail_id), false);
    assert_eq!(client.get_proposal_status(&prop_fail_id), ProposalStatus::Defeated);
    assert_eq!(client.get_proposal_state(&prop_fail_id), ProposalStatus::Defeated);

    client.evaluate_proposal(&prop_fail_id);
    assert_eq!(client.get_proposal(&prop_fail_id).status, ProposalStatus::Defeated);
    assert_eq!(client.get_proposal_status(&prop_fail_id), ProposalStatus::Defeated);
    assert_eq!(client.get_proposal_state(&prop_fail_id), ProposalStatus::Defeated);
}

#[test]
fn test_proposal_cancellation_by_proposer_and_admin() {
    let TestContext {
        env,
        client,
        admin,
        token_client,
        early_keepers,
        eligible_proposer,
        ..
    } = setup();

    env.ledger().set_sequence_number(100);

    let voter = Address::generate(&env);
    let stranger = Address::generate(&env);
    token_client.transfer(&early_keepers, &voter, &(5_000_000 * ONE_TOKEN));

    // Case 1: Proposer cancels active proposal during voting
    let action_1 = GovernableAction::SetFeeBps(150);
    let prop_1 = client.create_proposal(&eligible_proposer, &action_1);
    assert_eq!(client.get_proposal_status(&prop_1), ProposalStatus::Active);

    // Stranger cannot cancel
    let err_stranger = client.try_cancel_proposal(&stranger, &prop_1);
    assert_eq!(err_stranger, Err(Ok(GovernanceError::Unauthorized)));

    // Proposer successfully cancels
    client.cancel_proposal(&eligible_proposer, &prop_1);
    assert_eq!(client.get_proposal(&prop_1).status, ProposalStatus::Cancelled);
    assert_eq!(client.get_proposal_status(&prop_1), ProposalStatus::Cancelled);
    assert_eq!(client.get_proposal_state(&prop_1), ProposalStatus::Cancelled);

    // Voting on cancelled proposal fails
    let err_vote = client.try_vote(&voter, &prop_1, &VoteChoice::For);
    assert_eq!(err_vote, Err(Ok(GovernanceError::VotingEnded)));

    // Cancelling an already cancelled proposal fails
    let err_recancel = client.try_cancel_proposal(&eligible_proposer, &prop_1);
    assert_eq!(err_recancel, Err(Ok(GovernanceError::ProposalAlreadyCancelled)));

    // Case 2: Admin cancels queued proposal during timelock delay (emergency veto)
    let action_2 = GovernableAction::SetVotingPeriod(60_000);
    let prop_2 = client.create_proposal(&eligible_proposer, &action_2);
    client.vote(&voter, &prop_2, &VoteChoice::For);

    let prop_2_info = client.get_proposal(&prop_2);
    env.ledger().set_sequence_number((prop_2_info.voting_end as u32) + 1);
    let eta = client.queue_proposal(&prop_2);
    assert_eq!(client.get_proposal(&prop_2).status, ProposalStatus::Queued);

    // Admin executes emergency veto before execution
    client.cancel_proposal(&admin, &prop_2);
    assert_eq!(client.get_proposal(&prop_2).status, ProposalStatus::Cancelled);

    // Executing cancelled proposal fails
    env.ledger().set_sequence_number(eta as u32);
    let err_exec = client.try_execute_proposal(&prop_2);
    assert_eq!(err_exec, Err(Ok(GovernanceError::ProposalNotQueued)));

    // Case 3: Executed proposal cannot be cancelled
    let action_3 = GovernableAction::SetFeeBps(200);
    let prop_3 = client.create_proposal(&eligible_proposer, &action_3);
    client.vote(&voter, &prop_3, &VoteChoice::For);
    let prop_3_info = client.get_proposal(&prop_3);
    env.ledger().set_sequence_number((prop_3_info.voting_end as u32) + 1);
    let eta_3 = client.queue_proposal(&prop_3);
    env.ledger().set_sequence_number(eta_3 as u32);
    client.execute_proposal(&prop_3);
    assert_eq!(client.get_proposal(&prop_3).status, ProposalStatus::Executed);

    let err_cancel_exec = client.try_cancel_proposal(&admin, &prop_3);
    assert_eq!(err_cancel_exec, Err(Ok(GovernanceError::CannotCancelExecuted)));
}



