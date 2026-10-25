//! Integration and acceptance tests for `GovernanceClient` (Issue #503).
//!
//! Mirrors the full proposal lifecycle: initialization, view verification,
//! voting power check, proposal creation, voting, timelock delay validation,
//! typed error decoding, execution against registry, and double-execution protection.

use governance::GovernanceContract;
use keeper_registry::{KeeperRegistry, KeeperRegistryClient};
use soroban_keeper_sdk::{
    decode_governance_error, GovernableAction, GovernanceClient, GovernanceError, KeypairSigner,
    ProposalStatus, TransactionSigner,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, Env,
};

#[allow(dead_code)]
struct TestSetup<'a> {
    env: Env,
    admin: Address,
    token_id: Address,
    registry_id: Address,
    governance_id: Address,
    client: GovernanceClient<'a, KeypairSigner>,
    signer: KeypairSigner,
    registry_client: KeeperRegistryClient<'a>,
}

fn setup<'a>(env: &'a Env, signer: &'a KeypairSigner) -> TestSetup<'a> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 10_000);

    let admin = signer.address();
    let token_admin = Address::generate(env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceClient::new(env, governance_id.clone(), signer);

    let registry_id = env.register(KeeperRegistry, ());
    let registry_client = KeeperRegistryClient::new(env, &registry_id);

    // Wire registry with governance as admin and initial 300 bps fee
    registry_client.initialize(&governance_id, &token_id, &300u32);

    TestSetup {
        env: env.clone(),
        admin,
        token_id,
        registry_id,
        governance_id,
        client,
        signer: KeypairSigner::new(signer.address()),
        registry_client,
    }
}

#[test]
fn test_governance_client_full_proposal_lifecycle_and_views() {
    let env = Env::default();
    let admin_addr = Address::generate(&env);
    let signer = KeypairSigner::new(admin_addr.clone());
    let s = setup(&env, &signer);

    // 1. Initialize governance contract
    s.client
        .initialize(&s.token_id, &s.registry_id)
        .expect("initialization must succeed");

    // Re-initialization must fail and decode GovernanceError::AlreadyInitialized
    let reinit_err = s
        .client
        .initialize(&s.token_id, &s.registry_id)
        .expect_err("re-initialization must fail");
    assert_eq!(
        decode_governance_error(&reinit_err),
        Some(GovernanceError::AlreadyInitialized)
    );

    // 2. Verify all views
    assert_eq!(s.client.version(), 1);
    assert_eq!(s.client.admin().unwrap(), s.admin);
    assert_eq!(s.client.kprs_token().unwrap(), s.token_id);
    assert_eq!(s.client.registry().unwrap(), s.registry_id);

    // 3. Voting power view reflects token balance
    let voter = Address::generate(&env);
    assert_eq!(s.client.get_voting_power(&voter).unwrap(), 0);

    let mint_amount = 2_500_000_000_000i128; // 250,000 KPRS
    token::StellarAssetClient::new(&env, &s.token_id).mint(&voter, &mint_amount);
    assert_eq!(s.client.get_voting_power(&voter).unwrap(), mint_amount);

    // 4. Create proposal to update protocol fee to 750 bps with a 48h timelock
    let now = env.ledger().timestamp();
    let eta = now + 172_800;
    let proposal_id = s
        .client
        .create_proposal(&GovernableAction::SetFeeBps(750), eta)
        .expect("proposal creation must succeed");

    assert_eq!(proposal_id, 1);

    // 5. Query proposal view
    let proposal = s
        .client
        .get_proposal(proposal_id)
        .expect("proposal must exist");
    assert_eq!(proposal.id, proposal_id);
    assert_eq!(proposal.proposer, s.admin);
    assert_eq!(proposal.action, GovernableAction::SetFeeBps(750));
    assert_eq!(proposal.eta, eta);
    assert_eq!(proposal.status, ProposalStatus::Queued);

    // 6. Cast vote
    s.client
        .vote(proposal_id, 1)
        .expect("casting vote must succeed");

    // 7. Premature execution before timelock ETA must fail with TimelockNotElapsed
    let premature_err = s
        .client
        .execute_proposal(proposal_id)
        .expect_err("premature execution before timelock must fail");
    assert_eq!(
        decode_governance_error(&premature_err),
        Some(GovernanceError::TimelockNotElapsed)
    );

    // 8. Advance ledger past timelock ETA
    env.ledger().set_timestamp(eta + 1);

    // 9. Execute proposal
    s.client
        .execute_proposal(proposal_id)
        .expect("execution after timelock must succeed");

    // Verify proposal status updated to Executed
    let executed_proposal = s.client.get_proposal(proposal_id).unwrap();
    assert_eq!(executed_proposal.status, ProposalStatus::Executed);

    // Verify effect landed on registry
    assert_eq!(s.registry_client.get_fee_bps(), 750u32);

    // 10. Attempting double-execution must fail with ProposalAlreadyExecuted
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
