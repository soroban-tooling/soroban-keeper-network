//! Integration and acceptance tests for `GovernanceClient` (Issue #503).
//!
//! Exercises the real proposal lifecycle against the deployed contract:
//! initialization, view verification, snapshot voting power, proposal creation,
//! voting, deterministic evaluation, timelock queuing and execution, typed error
//! decoding, and double-execution protection.

use governance::GovernanceContract;
use governance_token::{GovernanceToken, GovernanceTokenClient};
use keeper_registry::{KeeperRegistry, KeeperRegistryClient};
use soroban_keeper_sdk::{
    decode_governance_error, GovernableAction, GovernanceClient, GovernanceError, KeypairSigner,
    ProposalStatus, TransactionSigner, VoteChoice,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

#[allow(dead_code)]
struct TestSetup<'a> {
    env: Env,
    admin: Address,
    token_id: Address,
    registry_id: Address,
    governance_id: Address,
    client: GovernanceClient<'a, KeypairSigner>,
    registry_client: KeeperRegistryClient<'a>,
}

/// Registers the token, registry and governance contracts and wires them together.
///
/// The governance deployer (`signer`) is the KPRS token's `early_keepers` holder,
/// so it owns the 40M-KPRS allocation — comfortably above the proposal threshold —
/// and can both propose and vote.
fn setup<'a>(env: &'a Env, signer: &'a KeypairSigner) -> TestSetup<'a> {
    env.mock_all_auths();

    let proposer = signer.address();
    let token_admin = Address::generate(env);
    let treasury = Address::generate(env);
    let core_team = Address::generate(env);
    let public_dist = Address::generate(env);

    let token_id = env.register(GovernanceToken, ());
    let token_client = GovernanceTokenClient::new(env, &token_id);
    // `proposer` receives the early-keepers allocation (40M KPRS).
    token_client.initialize(&token_admin, &proposer, &treasury, &core_team, &public_dist);

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceClient::new(env, governance_id.clone(), signer);

    let registry_id = env.register(KeeperRegistry, ());
    let registry_client = KeeperRegistryClient::new(env, &registry_id);
    registry_client.initialize(&governance_id, &token_id, &300u32);

    TestSetup {
        env: env.clone(),
        admin: proposer,
        token_id,
        registry_id,
        governance_id,
        client,
        registry_client,
    }
}

#[test]
fn test_governance_client_full_proposal_lifecycle_and_views() {
    let env = Env::default();
    let admin_addr = Address::generate(&env);
    let signer = KeypairSigner::new(admin_addr.clone());
    let s = setup(&env, &signer);

    // 1. Initialize governance contract.
    s.client
        .initialize(&s.token_id, &s.registry_id)
        .expect("initialization must succeed");

    // Re-initialization must fail and decode GovernanceError::AlreadyInitialized.
    let reinit_err = s
        .client
        .initialize(&s.token_id, &s.registry_id)
        .expect_err("re-initialization must fail");
    assert_eq!(
        decode_governance_error(&reinit_err),
        Some(GovernanceError::AlreadyInitialized)
    );

    // 2. Verify views.
    assert_eq!(s.client.version(), 1);
    assert_eq!(s.client.admin().unwrap(), s.admin);
    assert_eq!(s.client.kprs_token().unwrap(), s.token_id);
    assert_eq!(s.client.registry().unwrap(), s.registry_id);

    // 3. Voting power view reflects the token balance snapshot.
    assert!(s.client.get_voting_power(&s.admin).unwrap() > 0);

    // 4. Create a meta-governance proposal to raise the quorum to 1000 bps.
    let proposal_id = s
        .client
        .create_proposal(&GovernableAction::SetQuorumBps(1_000))
        .expect("proposal creation must succeed");
    assert_eq!(proposal_id, 1);

    // 5. Query the proposal view.
    let proposal = s
        .client
        .get_proposal(proposal_id)
        .expect("proposal must exist");
    assert_eq!(proposal.id, proposal_id);
    assert_eq!(proposal.proposer, s.admin);
    assert_eq!(proposal.action, GovernableAction::SetQuorumBps(1_000));
    assert_eq!(proposal.status, ProposalStatus::Active);

    // 6. Cast a vote in favour. Weight is the proposer's snapshot balance.
    s.client
        .vote(proposal_id, VoteChoice::For)
        .expect("casting vote must succeed");

    // 7. Advance past the voting period, then queue (which evaluates first).
    let voting_period = s.client.raw().voting_period();
    env.ledger().with_mut(|li| li.sequence_number += voting_period + 1);
    s.client
        .raw()
        .queue_proposal(&proposal_id);
    assert_eq!(
        s.client.get_proposal(proposal_id).unwrap().status,
        ProposalStatus::Queued
    );

    // 8. Premature execution before the timelock elapses must fail.
    let premature_err = s
        .client
        .execute_proposal(proposal_id)
        .expect_err("premature execution before timelock must fail");
    assert_eq!(
        decode_governance_error(&premature_err),
        Some(GovernanceError::TimelockNotElapsed)
    );

    // 9. Advance past the timelock and execute.
    let timelock = s.client.raw().timelock_delay();
    env.ledger().with_mut(|li| li.sequence_number += timelock + 1);
    s.client
        .execute_proposal(proposal_id)
        .expect("execution after timelock must succeed");

    assert_eq!(
        s.client.get_proposal(proposal_id).unwrap().status,
        ProposalStatus::Executed
    );
    // The meta-governance effect landed: quorum is now 1000 bps.
    assert_eq!(s.client.raw().quorum_bps(), 1_000);

    // 10. Double execution must fail with ProposalAlreadyExecuted.
    let repeat_err = s
        .client
        .execute_proposal(proposal_id)
        .expect_err("double execution must be rejected");
    assert_eq!(
        decode_governance_error(&repeat_err),
        Some(GovernanceError::ProposalAlreadyExecuted)
    );
}

#[test]
fn test_governance_client_nonexistent_proposal_error_decoding() {
    let env = Env::default();
    let admin_addr = Address::generate(&env);
    let signer = KeypairSigner::new(admin_addr.clone());
    let s = setup(&env, &signer);

    s.client
        .initialize(&s.token_id, &s.registry_id)
        .expect("initialization must succeed");

    let err = s
        .client
        .get_proposal(9999)
        .expect_err("nonexistent proposal must error");
    assert_eq!(
        decode_governance_error(&err),
        Some(GovernanceError::ProposalNotFound)
    );
}
