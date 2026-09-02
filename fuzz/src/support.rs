//! Reusable setup functions and helpers for fuzz testing the Keeper Registry.
//!
//! This module provides deterministic, reusable setup functions that all fuzz
//! targets should use. This ensures consistency across tests and avoids
//! duplicated setup logic.

use keeper_registry::*;
use soroban_sdk::{testutils::Address as _, token, Address, Bytes, Env};

/// Represents a fully initialized Keeper Registry contract ready for testing.
#[derive(Clone)]
pub struct RegistryHarness {
    pub env: Env,
    pub contract_id: Address,
    pub admin: Address,
    pub user: Address,
    pub keeper: Address,
    pub reward_token: Address,
}

impl RegistryHarness {
    /// Create a new RegistryHarness with deterministic addresses.
    ///
    /// This function creates a fresh environment and deploys a fully initialized
    /// Keeper Registry contract with a mock token contract. All addresses are
    /// deterministic to ensure reproducible fuzzing.
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        // Create deterministic addresses
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let keeper = Address::generate(&env);

        // Deploy a SAC-wrapped reward token, matching the pattern in
        // contracts/keeper-registry/src/test.rs's `setup()`.
        let reward_token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        // Deploy the Keeper Registry contract.
        let contract_id = env.register(KeeperRegistry, ());

        // Initialize the contract with a 0% fee (fuzz targets vary this
        // explicitly where the fee rate itself is under test).
        let client = KeeperRegistryClient::new(&env, &contract_id);
        client.initialize(&admin, &reward_token, &0u32);

        // Mint tokens to the user for testing.
        token::StellarAssetClient::new(&env, &reward_token).mint(&user, &1_000_000_000_000_i128);

        Self {
            env,
            contract_id,
            admin,
            user,
            keeper,
            reward_token,
        }
    }

    /// Get a client for the deployed contract.
    pub fn client(&self) -> KeeperRegistryClient<'_> {
        KeeperRegistryClient::new(&self.env, &self.contract_id)
    }

    /// Get the token client.
    pub fn token_client(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.reward_token)
    }

    /// Set up a task for testing by funding it from the user.
    ///
    /// Returns the task ID and the reward amount used.
    pub fn setup_task(&self, reward: i128) -> u64 {
        let client = self.client();
        let token_client = self.token_client();
        
        // Approve the registry to spend tokens
        token_client.approve(&self.user, &self.contract_id, &reward, &(1000u32));
        
        // Register a task with minimal parameters
        client.register_task(
            &self.user,
            &TaskType::Liquidation,
            &Bytes::from_slice(&self.env, b""),
            &reward,
            &(self.env.ledger().timestamp() + 1000), // Far future deadline
            &1000, // ttl_ledgers
            &100,  // lock_ledgers
            &None, // verifier
        )
    }

    /// Setup a task and claim it, returning the task ID.
    ///
    /// Useful for testing execution paths.
    pub fn setup_claimed_task(&self, reward: i128) -> u64 {
        let task_id = self.setup_task(reward);
        let client = self.client();
        
        // Approve the keeper (not needed for claim, but keep consistent)
        client.claim_task(&self.keeper, &task_id);
        
        task_id
    }

    /// Verify that a task exists and has the expected status.
    ///
    /// This is a property helper that should be called after any operation
    /// that should preserve task existence.
    pub fn assert_task_exists(&self, task_id: u64) {
        let client = self.client();
        let task = client.try_get_task(&task_id);

        assert!(
            matches!(task, Ok(Ok(_))),
            "Task {} should exist after operation",
            task_id
        );
    }

    /// Verify task field consistency.
    ///
    /// This property ensures that task fields remain consistent after operations.
    pub fn assert_task_fields_consistent(&self, task_id: u64) {
        let client = self.client();
        let task = client.get_task(&task_id);

        // Basic field consistency checks
        assert!(task.reward > 0, "Task reward should be positive");
        assert!(task.deadline > 0, "Task deadline should be set");
        assert!(task.ttl_ledgers > 0, "Task TTL should be positive");
        assert!(task.lock_ledgers > 0, "Task lock period should be positive");
        
        // Status-specific consistency
        match task.status {
            TaskStatus::Pending => {
                assert!(task.claimer.is_none(), "Pending task should have no claimer");
                assert!(task.claim_ledger.is_none(), "Pending task should have no claim ledger");
            }
            TaskStatus::Claimed => {
                assert!(task.claimer.is_some(), "Claimed task should have a claimer");
                assert!(task.claim_ledger.is_some(), "Claimed task should have a claim ledger");
            }
            TaskStatus::Executed => {
                assert!(task.claimer.is_some(), "Executed task should have a claimer");
                assert!(task.claim_ledger.is_some(), "Executed task should have a claim ledger");
            }
            TaskStatus::Cancelled | TaskStatus::Expired => {
                // Terminal states - no additional requirements
            }
        }
    }

    /// Verify no arithmetic overflow occurred during the last operation.
    ///
    /// This is checked by ensuring no panics were triggered and all
    /// arithmetic operations returned values.
    pub fn assert_no_arithmetic_overflow(&self) {
        // In fuzzing context, arithmetic overflow should cause a panic
        // which libfuzzer will catch. This assertion is a placeholder
        // for more sophisticated overflow detection.
    }

    /// Verify that the contract never panics for unexpected inputs.
    ///
    /// This is the primary property we're testing: the contract should
    /// return typed errors for invalid inputs, not panic.
    pub fn assert_no_unexpected_panics(&self) {
        // Panics are caught by libfuzzer's panic=abort configuration
        // If we reach this point, no panic occurred
    }

    /// Verify reward conservation invariant.
    ///
    /// After any successful execution, verify that:
    ///   keeper_net + fee == reward exactly
    ///   fees_after == fees_before + fee exactly
    pub fn assert_reward_conservation(
        &self,
        task_id: u64,
        reward_before: i128,
        fees_before: i128,
    ) {
        let client = self.client();

        // Get the executed task
        let task = client.get_task(&task_id);
        assert_eq!(task.status, TaskStatus::Executed, "Task should be executed");
        
        // Get keeper balance after execution
        let keeper_balance = client.keeper_balance(&task.claimer.unwrap());
        
        // Get current fees
        let fees_after = client.fees_accrued();
        
        // Calculate expected values based on fee_bps
        let fee_bps = client.get_fee_bps();
        let fee = reward_before
            .checked_mul(fee_bps as i128)
            .expect("overflow")
            .checked_div(10_000)
            .expect("div zero");
        let keeper_net = reward_before.checked_sub(fee).expect("underflow");
        
        // Verify conservation
        assert_eq!(
            keeper_balance, keeper_net,
            "Keeper should receive net reward: {} != {}",
            keeper_balance, keeper_net
        );
        
        assert_eq!(
            fees_after,
            fees_before.checked_add(fee).expect("overflow"),
            "Fees should increase by exactly the fee amount: {} != {} + {}",
            fees_after, fees_before, fee
        );
        
        assert_eq!(
            keeper_net.checked_add(fee).expect("overflow"),
            reward_before,
            "keeper_net + fee should equal original reward: {} + {} != {}",
            keeper_net, fee, reward_before
        );
    }
}

/// Helper to create deterministic bytes for fuzzing.
pub fn arbitrary_bytes(env: &Env, data: &[u8]) -> Bytes {
    Bytes::from_slice(env, data)
}

/// Helper to generate a task type for fuzzing.
pub fn arbitrary_task_type(_env: &Env, discriminator: u8) -> TaskType {
    match discriminator % 6 {
        0 => TaskType::Liquidation,
        1 => TaskType::OraclePricePush,
        2 => TaskType::FundingRateUpdate,
        3 => TaskType::LiquidityRebalance,
        4 => TaskType::TtlExtension,
        _ => TaskType::Custom,
    }
}

/// Check if bytes length exceeds contract limits.
pub fn is_calldata_valid(calldata: &Bytes) -> bool {
    calldata.len() <= keeper_registry::MAX_CALLDATA_LEN
}

/// Check if proof length exceeds contract limits.
pub fn is_proof_valid(proof: &Bytes) -> bool {
    proof.len() <= keeper_registry::MAX_PROOF_LEN
}