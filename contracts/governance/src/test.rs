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
    governance_id: Address,
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
        governance_id,
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
    assert_eq!(registry_client.fee_bps(), 300u32);

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
        registry_client.fee_bps(),
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

    assert_eq!(registry_client.fee_bps(), 300u32);

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
        registry_client.fee_bps(),
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
