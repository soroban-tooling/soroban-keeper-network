#![cfg(test)]

use super::*;
use keeper_registry::{KeeperRegistry, KeeperRegistryClient as RegistryTestClient};
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger as _, token, Address, Env,
};

struct TestSetup {
    env: Env,
    admin: Address,
    token_id: Address,
    registry_id: Address,
    _governance_id: Address,
    client: GovernanceContractClient<'static>,
    registry_client: RegistryTestClient<'static>,
}

#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &governance_id);

    let registry_id = env.register(KeeperRegistry, ());
    let registry_client = RegistryTestClient::new(&env, &registry_id);

    // Initialize registry with governance contract as its authorized admin
    registry_client.initialize(&governance_id, &token_id, &300u32);

    // Initialize governance contract
    client.initialize(&admin, &token_id, &registry_id);

    TestSetup {
        env: unsafe { core::mem::transmute(env) },
        admin,
        token_id,
        registry_id,
        _governance_id: governance_id,
        client: unsafe { core::mem::transmute(client) },
        registry_client: unsafe { core::mem::transmute(registry_client) },
    }
}

#[test]
fn test_version_view_and_initialization() {
    let TestSetup {
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

    // Re-initialization must fail
    let res = client.try_initialize(&admin, &token_id, &registry_id);
    assert_eq!(res, Err(Ok(GovernanceError::AlreadyInitialized)));
}

#[test]
fn test_voting_power_reads_from_kprs_token_contract() {
    let TestSetup {
        env,
        token_id,
        client,
        ..
    } = setup();

    let voter = Address::generate(&env);
    assert_eq!(client.get_voting_power(&voter), 0i128);

    let mint_amount = 5_000_000_000_000i128; // 500,000 KPRS
    token::StellarAssetClient::new(&env, &token_id).mint(&voter, &mint_amount);
    assert_eq!(client.get_voting_power(&voter), mint_amount);
}

#[test]
fn test_execute_proposal_ordering_and_double_execution_prevention() {
    let TestSetup {
        env,
        client,
        registry_client,
        ..
    } = setup();

    let proposer = Address::generate(&env);
    let now = env.ledger().timestamp();

    // 1. Queue a valid proposal to update protocol fee to 500 bps
    let proposal_id = client.create_proposal(
        &proposer,
        &GovernableAction::SetFeeBps(500),
        &now,
    );

    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.status, ProposalStatus::Queued);
    assert_eq!(registry_client.get_fee_bps(), 300u32);

    // 2. Execute the proposal (First time: must succeed)
    client.execute_proposal(&proposal_id);

    // Verify state transition and effect on registry
    let executed_proposal = client.get_proposal(&proposal_id);
    assert_eq!(
        executed_proposal.status,
        ProposalStatus::Executed,
        "Proposal must transition to Executed"
    );
    assert_eq!(
        registry_client.get_fee_bps(),
        500u32,
        "Registry fee must reflect the executed change"
    );

    // 3. Acceptance Criterion: Attempting to call execute_proposal a second time
    // MUST be strictly rejected and cannot execute twice.
    let repeat_res = client.try_execute_proposal(&proposal_id);
    assert_eq!(
        repeat_res,
        Err(Ok(GovernanceError::ProposalAlreadyExecuted)),
        "execute_proposal cannot be called twice for the same already-executed proposal"
    );
}

#[test]
fn test_underlying_registry_call_failure_leaves_proposal_recoverable() {
    let TestSetup {
        env,
        client,
        registry_client,
        ..
    } = setup();

    let proposer = Address::generate(&env);
    let now = env.ledger().timestamp();

    // 1. Propose an invalid fee of 15,000 bps (registry enforces fee_bps <= 10,000)
    let invalid_proposal_id = client.create_proposal(
        &proposer,
        &GovernableAction::SetFeeBps(15_000),
        &now,
    );

    assert_eq!(registry_client.get_fee_bps(), 300u32);

    // 2. Attempt execution: registry validation fails (InvalidFeeBps)
    let res = client.try_execute_proposal(&invalid_proposal_id);
    assert_eq!(
        res,
        Err(Ok(GovernanceError::RegistryCallFailed)),
        "Cross-contract validation failure must be caught and reported"
    );

    // 3. Acceptance Criterion: Proposal must be left in a recoverable state (Queued),
    // and NOT silently marked as Executed when the change did not land.
    let proposal = client.get_proposal(&invalid_proposal_id);
    assert_eq!(
        proposal.status,
        ProposalStatus::Queued,
        "Proposal must remain in recoverable Queued status upon downstream call failure"
    );

    // Registry fee must remain untouched at original value
    assert_eq!(
        registry_client.get_fee_bps(),
        300u32,
        "Registry fee must remain unchanged at original rate"
    );
}

#[test]
fn test_timelock_delay_enforced_before_execution() {
    let TestSetup {
        env,
        client,
        ..
    } = setup();

    let proposer = Address::generate(&env);
    let now = env.ledger().timestamp();
    let future_eta = now + 172_800; // 48 hours timelock delay

    let proposal_id = client.create_proposal(
        &proposer,
        &GovernableAction::Pause,
        &future_eta,
    );

    // Execution before ETA must fail
    let premature_res = client.try_execute_proposal(&proposal_id);
    assert_eq!(
        premature_res,
        Err(Ok(GovernanceError::TimelockNotElapsed)),
        "Execution before timelock expiry must be rejected"
    );

    // Advance ledger timestamp to ETA
    env.ledger().set_timestamp(future_eta);

    // Execution at or after ETA succeeds
    client.execute_proposal(&proposal_id);
    assert_eq!(
        client.get_proposal(&proposal_id).status,
        ProposalStatus::Executed
    );
}

#[test]
fn test_tally_exact_vote_conservation_and_weights() {
    let votes = [
        (5_000_000i128, 1u32), // 5M For
        (2_000_000i128, 0u32), // 2M Against
        (1_000_000i128, 2u32), // 1M Abstain
        (3_000_000i128, 1u32), // 3M For
    ];

    let tally = calculate_tally(&votes).expect("valid tally");
    assert_eq!(tally.for_votes, 8_000_000i128);
    assert_eq!(tally.against_votes, 2_000_000i128);
    assert_eq!(tally.abstain_votes, 1_000_000i128);
    assert_eq!(tally.total_votes, 11_000_000i128);
    assert_eq!(
        tally.for_votes + tally.against_votes + tally.abstain_votes,
        tally.total_votes,
        "Total turnout must strictly conserve all category votes"
    );
}

#[test]
fn test_tally_negative_voting_power_and_invalid_choice_rejected() {
    let negative_vote = [(-100i128, 1u32)];
    assert_eq!(
        calculate_tally(&negative_vote),
        Err(GovernanceError::InvalidVotingPower),
        "Negative voting power must be strictly rejected"
    );

    let invalid_choice = [(100i128, 5u32)];
    assert_eq!(
        calculate_tally(&invalid_choice),
        Err(GovernanceError::InvalidVoteChoice),
        "Invalid choice (>2) must be strictly rejected"
    );
}

#[test]
fn test_tally_arithmetic_overflow_detected_no_silent_wrap() {
    let overflow_votes = [
        (i128::MAX, 1u32),
        (1i128, 1u32),
    ];
    assert_eq!(
        calculate_tally(&overflow_votes),
        Err(GovernanceError::ArithmeticOverflow),
        "Addition exceeding i128::MAX must return ArithmeticOverflow, never wrap"
    );
}

#[test]
fn test_quorum_threshold_arithmetic_and_decomposition() {
    let total_supply = 1_000_000_000_000_000i128; // 100M KPRS (7 decimals)
    let quorum_bps = 400u32; // 4% quorum requirement
    let threshold = compute_quorum_threshold(total_supply, quorum_bps).expect("quorum calculation");
    assert_eq!(threshold, 40_000_000_000_000i128); // 4M KPRS

    // Invalid quorum bps > 10,000 must fail
    assert_eq!(
        compute_quorum_threshold(total_supply, 10_001),
        Err(GovernanceError::InvalidQuorumBps)
    );

    // Extreme total supply near i128::MAX must not panic or wrap
    let extreme_supply = i128::MAX;
    let res = compute_quorum_threshold(extreme_supply, 5_000);
    assert!(res.is_ok(), "Quotient decomposition must handle extreme supply without overflow");
    let extreme_threshold = res.unwrap();
    assert!(extreme_threshold > 0 && extreme_threshold < extreme_supply);
}

#[test]
fn test_proposal_outcome_evaluation_quorum_and_majority() {
    let total_supply = 100_000_000i128;
    let quorum_bps = 400u32; // 4M required quorum

    // Case 1: Quorum not met -> fails even if 100% For
    let tally_no_quorum = ProposalTally {
        for_votes: 3_000_000,
        against_votes: 0,
        abstain_votes: 0,
        total_votes: 3_000_000,
    };
    assert_eq!(
        evaluate_proposal_outcome(&tally_no_quorum, total_supply, quorum_bps).unwrap(),
        false,
        "Proposal below quorum must fail"
    );

    // Case 2: Quorum met, but Against > For -> fails
    let tally_defeated = ProposalTally {
        for_votes: 2_000_000,
        against_votes: 3_000_000,
        abstain_votes: 0,
        total_votes: 5_000_000,
    };
    assert_eq!(
        evaluate_proposal_outcome(&tally_defeated, total_supply, quorum_bps).unwrap(),
        false,
        "Proposal where Against >= For must fail"
    );

    // Case 3: Quorum met, tie For == Against -> fails
    let tally_tie = ProposalTally {
        for_votes: 2_500_000,
        against_votes: 2_500_000,
        abstain_votes: 0,
        total_votes: 5_000_000,
    };
    assert_eq!(
        evaluate_proposal_outcome(&tally_tie, total_supply, quorum_bps).unwrap(),
        false,
        "Ties must fail"
    );

    // Case 4: Quorum met, For > Against -> passes
    let tally_passed = ProposalTally {
        for_votes: 4_000_000,
        against_votes: 1_000_000,
        abstain_votes: 1_000_000,
        total_votes: 6_000_000,
    };
    assert_eq!(
        evaluate_proposal_outcome(&tally_passed, total_supply, quorum_bps).unwrap(),
        true,
        "Proposal meeting quorum with simple majority For > Against must pass"
    );
}

#[test]
fn test_timelock_boundary_delay_minus_one_exact_and_plus_one() {
    let queued_at = 1_000_000u64;
    let delay = 172_800u64; // 48 hours
    let eta = compute_timelock_eta(queued_at, delay).expect("eta calculation");
    assert_eq!(eta, 1_172_800u64);

    // Boundary 1: eta - 1 -> NOT elapsed, remaining == 1
    assert!(!is_timelock_elapsed(eta - 1, eta), "eta - 1 must still be locked");
    assert_eq!(remaining_timelock_delay(eta - 1, eta), 1);

    // Boundary 2: exactly at eta -> ELAPSED, remaining == 0
    assert!(is_timelock_elapsed(eta, eta), "at eta timelock has elapsed");
    assert_eq!(remaining_timelock_delay(eta, eta), 0);

    // Boundary 3: eta + 1 -> ELAPSED, remaining == 0
    assert!(is_timelock_elapsed(eta + 1, eta), "after eta timelock is elapsed");
    assert_eq!(remaining_timelock_delay(eta + 1, eta), 0);

    // Timestamp overflow protection on eta
    let overflow_res = compute_timelock_eta(u64::MAX - 5, 10);
    assert_eq!(
        overflow_res,
        Err(GovernanceError::ArithmeticOverflow),
        "Overflowing timestamp addition must return typed error"
    );
}

