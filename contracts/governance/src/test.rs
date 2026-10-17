#![cfg(test)]

use super::*;
use keeper_registry::{
    KeeperError, KeeperRegistry, KeeperRegistryClient as RegistryTestClient,
};
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger as _, token, Address, BytesN, Env, Symbol,
};

#[allow(dead_code)]
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

#[allow(dead_code)]
struct PreMigrationSetup {
    env: Env,
    original_admin: Address,
    token_id: Address,
    registry_id: Address,
    governance_id: Address,
    client: GovernanceContractClient<'static>,
    registry_client: RegistryTestClient<'static>,
}

#[allow(clippy::useless_transmute, clippy::missing_transmute_annotations)]
fn setup_pre_migration() -> PreMigrationSetup {
    let env = Env::default();
    env.mock_all_auths();

    let original_admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let governance_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &governance_id);

    let registry_id = env.register(KeeperRegistry, ());
    let registry_client = RegistryTestClient::new(&env, &registry_id);

    // 1. Initialize keeper-registry with the original human admin
    registry_client.initialize(&original_admin, &token_id, &300u32);

    // 2. Initialize governance contract with a governance deployer/admin
    let gov_admin = Address::generate(&env);
    client.initialize(&gov_admin, &token_id, &registry_id);

    PreMigrationSetup {
        env: unsafe { core::mem::transmute(env) },
        original_admin,
        token_id,
        registry_id,
        governance_id,
        client: unsafe { core::mem::transmute(client) },
        registry_client: unsafe { core::mem::transmute(registry_client) },
    }
}

#[test]
fn test_one_time_admin_migration_full_lifecycle_and_irreversibility() {
    let PreMigrationSetup {
        env,
        original_admin,
        registry_id,
        governance_id,
        client,
        registry_client,
        ..
    } = setup_pre_migration();

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 1: Pre-migration state
    // ─────────────────────────────────────────────────────────────────────────
    assert_eq!(registry_client.admin(), Some(original_admin.clone()));
    assert_eq!(registry_client.get_fee_bps(), 300u32);

    // Original admin can execute admin-gated functions
    registry_client.set_fee_bps(&original_admin, &350u32);
    assert_eq!(registry_client.get_fee_bps(), 350u32);

    registry_client.set_min_reward(&original_admin, &100i128);
    registry_client.set_reputation_floor(&original_admin, &1_000u32);

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 2: One-time migration handshake
    // ─────────────────────────────────────────────────────────────────────────
    // The current admin calls accept_admin on governance to execute the handover.
    client.accept_admin(&original_admin, &registry_id);

    // Verify registry admin is now the governance contract address
    assert_eq!(
        registry_client.admin(),
        Some(governance_id.clone()),
        "Registry admin must be transferred to the governance contract"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 3: Total lockout of the original admin on ALL admin-gated functions
    // ─────────────────────────────────────────────────────────────────────────
    let dummy_addr = Address::generate(&env);
    let dummy_hash = BytesN::from_array(&env, &[7u8; 32]);

    assert_eq!(
        registry_client.try_set_fee_bps(&original_admin, &500u32),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call set_fee_bps after migration"
    );
    assert_eq!(
        registry_client.try_set_min_reward(&original_admin, &200i128),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call set_min_reward after migration"
    );
    assert_eq!(
        registry_client.try_set_reputation_floor(&original_admin, &2_000u32),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call set_reputation_floor after migration"
    );
    assert_eq!(
        registry_client.try_pause(&original_admin),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call pause after migration"
    );
    assert_eq!(
        registry_client.try_unpause(&original_admin),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call unpause after migration"
    );
    assert_eq!(
        registry_client.try_set_min_stake(&original_admin, &500i128),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call set_min_stake after migration"
    );
    assert_eq!(
        registry_client.try_set_dispute_window(&original_admin, &100u32),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot call set_dispute_window after migration"
    );
    assert_eq!(
        registry_client.try_transfer_admin(&original_admin, &dummy_addr),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot transfer admin after migration"
    );
    assert_eq!(
        registry_client.try_upgrade(&original_admin, &dummy_hash),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot upgrade registry after migration"
    );
    assert_eq!(
        registry_client.try_sweep_fees(&original_admin, &dummy_addr, &10i128),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot sweep fees after migration"
    );
    assert_eq!(
        registry_client.try_slash(
            &original_admin,
            &dummy_addr,
            &50i128,
            &Symbol::new(&env, "slash"),
            &dummy_addr
        ),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot slash keepers after migration"
    );
    assert_eq!(
        registry_client.try_resolve_slash_appeal(&original_admin, &1u64, &true),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot resolve slash appeals after migration"
    );
    assert_eq!(
        registry_client.try_resolve_execution_dispute(&original_admin, &1u64, &true),
        Err(Ok(KeeperError::Unauthorized)),
        "original_admin cannot resolve execution disputes after migration"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4: Decentralized governance control & parameter updates
    // ─────────────────────────────────────────────────────────────────────────
    let proposer = Address::generate(&env);
    let now = env.ledger().timestamp();

    // Create, queue, and execute a proposal to change fee_bps to 450
    let proposal_id = client.create_proposal(
        &proposer,
        &GovernableAction::SetFeeBps(450),
        &now,
    );
    client.execute_proposal(&proposal_id);
    assert_eq!(
        registry_client.get_fee_bps(),
        450u32,
        "Governance proposal must successfully update registry parameter"
    );

    // Create, queue, and execute a proposal to Pause the registry
    let pause_prop = client.create_proposal(
        &proposer,
        &GovernableAction::Pause,
        &now,
    );
    client.execute_proposal(&pause_prop);
    assert!(
        registry_client.is_paused(),
        "Governance proposal must successfully pause the registry"
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5: Irreversibility validation
    // ─────────────────────────────────────────────────────────────────────────
    // Original admin cannot repeat migration or reclaim admin
    let repeat_migration = client.try_accept_admin(&original_admin, &registry_id);
    assert_eq!(
        repeat_migration,
        Err(Ok(GovernanceError::RegistryCallFailed)),
        "Re-running accept_admin must fail because original_admin is no longer admin"
    );

    // Registry admin remains strictly the governance contract
    assert_eq!(registry_client.admin(), Some(governance_id));
}

#[test]
fn test_admin_migration_dual_auth_enforcement() {
    let PreMigrationSetup {
        env,
        original_admin,
        registry_id,
        governance_id,
        client,
        registry_client,
        ..
    } = setup_pre_migration();

    // 1. An imposter/stranger trying to call accept_admin fails
    let imposter = Address::generate(&env);
    let res = client.try_accept_admin(&imposter, &registry_id);
    assert_eq!(
        res,
        Err(Ok(GovernanceError::RegistryCallFailed)),
        "Imposter cannot migrate admin without being the current admin"
    );
    assert_eq!(registry_client.admin(), Some(original_admin.clone()));

    // 2. Calling accept_admin with the actual current_admin succeeds
    client.accept_admin(&original_admin, &registry_id);
    assert_eq!(registry_client.admin(), Some(governance_id));
}

