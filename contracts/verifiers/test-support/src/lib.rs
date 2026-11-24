//! Minimal test harness for third-party verifier authors.
//!
//! This crate provides a simple, focused API for testing verifier contracts against
//! the Keeper Registry without needing to understand the registry's internal test
//! infrastructure.
//!
//! # Quick Start
//!
//! Add to your verifier crate's `Cargo.toml`:
//! ```toml
//! [dev-dependencies]
//! keeper-registry-test-support = { path = "../path/to/contracts/verifiers/test-support" }
//! soroban-sdk = { version = "22.0.1", features = ["testutils"] }
//! ```
//!
//! # Example
//!
//! ```ignore
//! use keeper_registry_test_support::VerifierTestHarness;
//! use soroban_sdk::Bytes;
//!
//! #[test]
//! fn test_my_verifier() {
//!     let harness = VerifierTestHarness::new();
//!     let env = harness.env();
//!
//!     // `register` returns the contract's Address directly.
//!     let verifier = env.register(MyVerifier, ());
//!
//!     let task_id = harness
//!         .register_task_with_verifier(
//!             harness.owner_address(),
//!             Some(verifier),
//!             1_000_000,                       // reward in stroops
//!             env.ledger().timestamp() + 1000, // deadline
//!             &Bytes::from_slice(env, b"calldata"),
//!         )
//!         .unwrap();
//!
//!     harness.claim_task(harness.keeper_address(), task_id).unwrap();
//!     let proof = Bytes::from_slice(env, b"proof_bytes");
//!     harness
//!         .execute_task(harness.keeper_address(), task_id, &proof)
//!         .unwrap();
//!
//!     assert!(harness.keeper_balance(harness.keeper_address()) > 0);
//! }
//! ```

use keeper_registry::KeeperRegistryClient;
pub use keeper_registry::{
    KeeperError, Task, TaskStatus, TaskType, MAX_CALLDATA_LEN, MAX_PROOF_LEN,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Bytes, Env, InvokeError};

/// Collapse a generated `try_*` result into the registry's own error type.
/// A host-level failure (a panic that is not a `KeeperError`) is a bug in the
/// code under test, so it panics with the underlying error to make it visible.
fn contract_result<T, C: core::fmt::Debug>(
    result: Result<Result<T, C>, Result<KeeperError, InvokeError>>,
) -> Result<T, KeeperError> {
    match result {
        Ok(Ok(value)) => Ok(value),
        Err(Ok(error)) => Err(error),
        Ok(Err(error)) => panic!("unexpected return value conversion error: {error:?}"),
        Err(Err(error)) => panic!("unexpected host error: {error:?}"),
    }
}

/// A minimal test harness for verifier authors to test their contracts.
///
/// This harness manages a fully initialized Keeper Registry instance and provides
/// a simple API for registering tasks with verifiers, claiming them, and executing
/// with proofs.
///
/// # Example
///
/// ```ignore
/// let harness = VerifierTestHarness::new();
/// let task_id = harness.register_task_with_verifier(...).unwrap();
/// harness.claim_task(harness.keeper_address(), task_id).unwrap();
/// harness.execute_task(harness.keeper_address(), task_id, &proof).unwrap();
/// ```
pub struct VerifierTestHarness {
    env: Env,
    contract_id: Address,
    admin: Address,
    user: Address,
    keeper: Address,
    reward_token: Address,
}

impl VerifierTestHarness {
    /// Create a new test harness with a fully initialized registry.
    ///
    /// This deploys a fresh registry contract, initializes it with a mock token,
    /// and sets up deterministic test addresses. The registry starts with 0% fees.
    ///
    /// # Returns
    ///
    /// A new `VerifierTestHarness` ready for testing.
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        // Create deterministic addresses
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let keeper = Address::generate(&env);

        // Deploy a SAC-wrapped reward token
        let reward_token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        // Deploy the Keeper Registry contract
        let contract_id = env.register(keeper_registry::KeeperRegistry, ());

        // Initialize the contract with 0% fee
        let client = KeeperRegistryClient::new(&env, &contract_id);
        client.initialize(&admin, &reward_token, &0u32);

        // Mint tokens to the user for task registration
        StellarAssetClient::new(&env, &reward_token).mint(&user, &1_000_000_000_000_i128);

        Self {
            env,
            contract_id,
            admin,
            user,
            keeper,
            reward_token,
        }
    }

    /// Get a reference to the test environment.
    ///
    /// Use this to deploy your own verifier contract or access the Soroban test
    /// environment directly for advanced usage.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let env = harness.env();
    /// let verifier_id = env.register(MyVerifier, ());
    /// ```
    pub fn env(&self) -> &Env {
        &self.env
    }

    /// Get a client for the registry contract.
    fn client(&self) -> KeeperRegistryClient<'_> {
        KeeperRegistryClient::new(&self.env, &self.contract_id)
    }

    /// Register a task with an optional verifier contract attached.
    ///
    /// # Arguments
    ///
    /// * `owner` - Address funding the task (use `harness.owner_address()`; it is the funded account)
    /// * `verifier` - `None` to register without verification, `Some(address)` to attach your verifier
    /// * `reward` - Reward in stroops (token units)
    /// * `deadline` - Unix timestamp after which the task expires
    /// * `calldata` - Arbitrary bytes passed to your application (not used by registry)
    ///
    /// # Returns
    ///
    /// The registered task ID if successful, or a `KeeperError` if parameters are invalid.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let task_id = harness.register_task_with_verifier(
    ///     harness.owner_address(),
    ///     Some(verifier_address),
    ///     1_000_000,
    ///     env.ledger().timestamp() + 3600,
    ///     &Bytes::from_slice(&env, b"mydata"),
    /// ).unwrap();
    /// ```
    pub fn register_task_with_verifier(
        &self,
        owner: &Address,
        verifier: Option<Address>,
        reward: i128,
        deadline: u64,
        calldata: &Bytes,
    ) -> Result<u64, KeeperError> {
        let client = self.client();

        // The registry requires `ttl_ledgers` to cover the time until the deadline
        // (at ~5 s per ledger) plus a one-day safety margin (17,280 ledgers).
        // Derive it from the deadline so any deadline a test picks is accepted.
        let seconds_to_deadline = deadline.saturating_sub(self.env.ledger().timestamp());
        let ttl_ledgers = (seconds_to_deadline / 5 + 17_280 + 1_000).min(u32::MAX as u64) as u32;

        // Register the task with the verifier attached (no condition)
        contract_result(client.try_register_task(
            owner,
            &TaskType::Custom,
            calldata,
            &reward,
            &deadline,
            &ttl_ledgers,
            &100u32, // lock_ledgers
            &verifier,
            &None,
        ))
    }

    /// Claim an unexecuted task.
    ///
    /// # Arguments
    ///
    /// * `keeper` - Address claiming the task (use `harness.keeper_address()`)
    /// * `task_id` - ID of the task to claim
    ///
    /// # Returns
    ///
    /// `Ok(())` if the claim succeeded, or a `KeeperError` if the task cannot be claimed
    /// (e.g., already claimed by another keeper, or deadline passed).
    pub fn claim_task(&self, keeper: &Address, task_id: u64) -> Result<(), KeeperError> {
        contract_result(self.client().try_claim_task(keeper, &task_id))
    }

    /// Execute a claimed task with a proof.
    ///
    /// # Arguments
    ///
    /// * `keeper` - Address that claimed the task
    /// * `task_id` - ID of the claimed task
    /// * `proof` - Proof bytes that your verifier will validate
    ///
    /// # Returns
    ///
    /// `Ok(())` if execution succeeded and the keeper was credited, or a `KeeperError` if:
    /// - The task cannot be executed (not claimed, deadline passed, etc.)
    /// - Your verifier rejects the proof (returns `false`)
    /// - Your verifier panics
    pub fn execute_task(
        &self,
        keeper: &Address,
        task_id: u64,
        proof: &Bytes,
    ) -> Result<(), KeeperError> {
        contract_result(self.client().try_execute_task(keeper, &task_id, proof))
    }

    /// Get the current state of a task.
    ///
    /// # Arguments
    ///
    /// * `task_id` - ID of the task to retrieve
    ///
    /// # Returns
    ///
    /// The task record containing: owner, reward, deadline, status (Pending/Claimed/Executed),
    /// and other metadata.
    ///
    /// # Panics
    ///
    /// If the task does not exist.
    pub fn get_task(&self, task_id: u64) -> Task {
        self.client().get_task(&task_id)
    }

    /// Get a keeper's credited balance (post-execution reward).
    ///
    /// # Arguments
    ///
    /// * `keeper` - Address to check balance for
    ///
    /// # Returns
    ///
    /// The keeper's balance in stroops. Zero if they have never executed a task.
    pub fn keeper_balance(&self, keeper: &Address) -> i128 {
        self.client().keeper_balance(keeper)
    }

    /// Get the accumulated protocol fees.
    ///
    /// # Returns
    ///
    /// The total fees accrued by the registry. With 0% fee (default), this should be zero.
    pub fn fees_accrued(&self) -> i128 {
        self.client().fees_accrued()
    }

    /// Get the reward token address.
    ///
    /// Useful if you need to interact with the token directly.
    pub fn reward_token_address(&self) -> &Address {
        &self.reward_token
    }

    /// Get the registry contract address.
    ///
    /// Useful for advanced usage or debugging.
    pub fn registry_address(&self) -> &Address {
        &self.contract_id
    }

    /// Get the admin address.
    pub fn admin_address(&self) -> &Address {
        &self.admin
    }

    /// Get the task owner address.
    pub fn owner_address(&self) -> &Address {
        &self.user
    }

    /// Get the keeper address.
    pub fn keeper_address(&self) -> &Address {
        &self.keeper
    }
}

impl Default for VerifierTestHarness {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Assertion helpers
// ============================================================================

/// Assert that a task's escrow was released (funds moved).
///
/// Use this after a successful execution to verify the keeper was credited
/// and fees were accrued.
pub fn assert_escrow_released(harness: &VerifierTestHarness, task_id: u64) {
    let task = harness.get_task(task_id);
    assert_eq!(
        task.status,
        TaskStatus::Executed,
        "Task should be Executed after successful execution"
    );

    // Keeper should have a non-zero balance if the reward was positive
    let balance = harness.keeper_balance(harness.keeper_address());
    assert!(
        balance > 0,
        "Keeper should have a non-zero balance after execution"
    );
}

/// Assert that no escrow was moved (state unchanged).
///
/// Use this after a registration failure or execution rejection to verify
/// that the registry's state was not modified.
pub fn assert_no_escrow_movement(
    harness: &VerifierTestHarness,
    keeper_balance_before: i128,
    fees_before: i128,
) {
    let keeper_balance_after = harness.keeper_balance(harness.keeper_address());
    let fees_after = harness.fees_accrued();

    assert_eq!(
        keeper_balance_before, keeper_balance_after,
        "Keeper balance should not change"
    );
    assert_eq!(fees_before, fees_after, "Fees should not change");
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Ledger as _;

    #[test]
    fn harness_initializes_successfully() {
        let harness = VerifierTestHarness::new();

        // Registry should be initialized
        assert_ne!(harness.registry_address(), harness.reward_token_address());

        // Balances should start clean
        assert_eq!(harness.keeper_balance(harness.keeper_address()), 0);
        assert_eq!(harness.fees_accrued(), 0);
    }

    #[test]
    fn harness_can_register_task_without_verifier() {
        let harness = VerifierTestHarness::new();

        let task_id = harness
            .register_task_with_verifier(
                harness.owner_address(),
                None,
                1_000_000,
                harness.env().ledger().timestamp() + 1000,
                &Bytes::new(harness.env()),
            )
            .expect("Registration should succeed");

        let task = harness.get_task(task_id);
        assert_eq!(task.reward, 1_000_000);
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(&task.owner, harness.owner_address());
    }

    #[test]
    fn harness_can_claim_task() {
        let harness = VerifierTestHarness::new();

        let task_id = harness
            .register_task_with_verifier(
                harness.owner_address(),
                None,
                1_000_000,
                harness.env().ledger().timestamp() + 1000,
                &Bytes::new(harness.env()),
            )
            .unwrap();

        harness
            .claim_task(harness.keeper_address(), task_id)
            .unwrap();

        let task = harness.get_task(task_id);
        assert_eq!(task.status, TaskStatus::Claimed);
        assert_eq!(task.claimer.as_ref(), Some(harness.keeper_address()));
    }

    #[test]
    fn harness_can_execute_task() {
        let harness = VerifierTestHarness::new();

        let task_id = harness
            .register_task_with_verifier(
                harness.owner_address(),
                None,
                1_000_000,
                harness.env().ledger().timestamp() + 1000,
                &Bytes::new(harness.env()),
            )
            .unwrap();

        harness
            .claim_task(harness.keeper_address(), task_id)
            .unwrap();

        let proof = Bytes::new(harness.env());
        harness
            .execute_task(harness.keeper_address(), task_id, &proof)
            .unwrap();

        let task = harness.get_task(task_id);
        assert_eq!(task.status, TaskStatus::Executed);

        // Keeper should be credited
        let balance = harness.keeper_balance(harness.keeper_address());
        assert!(balance > 0);
    }

    #[test]
    fn harness_end_to_end_flow() {
        let harness = VerifierTestHarness::new();

        // Register
        let task_id = harness
            .register_task_with_verifier(
                harness.owner_address(),
                None,
                1_000_000,
                harness.env().ledger().timestamp() + 1000,
                &Bytes::from_slice(harness.env(), b"test_data"),
            )
            .unwrap();

        // Claim
        harness
            .claim_task(harness.keeper_address(), task_id)
            .unwrap();
        let task = harness.get_task(task_id);
        assert_eq!(task.status, TaskStatus::Claimed);

        // Execute
        let proof = Bytes::from_slice(harness.env(), b"proof_bytes");
        harness
            .execute_task(harness.keeper_address(), task_id, &proof)
            .unwrap();
        let task = harness.get_task(task_id);
        assert_eq!(task.status, TaskStatus::Executed);

        // Verify payment
        let balance = harness.keeper_balance(harness.keeper_address());
        assert_eq!(
            balance, 1_000_000,
            "Keeper should get full reward (0% fees)"
        );
    }

    #[test]
    fn harness_rejects_invalid_deadline() {
        let harness = VerifierTestHarness::new();

        // Deadline in the past (move the clock forward so the subtraction cannot underflow)
        harness.env().ledger().set_timestamp(1_000);
        let result = harness.register_task_with_verifier(
            harness.owner_address(),
            None,
            1_000_000,
            harness.env().ledger().timestamp() - 100, // past
            &Bytes::new(harness.env()),
        );

        assert!(
            matches!(result, Err(KeeperError::DeadlinePassed)),
            "Should reject past deadline"
        );
    }

    #[test]
    fn harness_rejects_invalid_reward() {
        let harness = VerifierTestHarness::new();

        // Zero reward
        let result = harness.register_task_with_verifier(
            harness.owner_address(),
            None,
            0, // invalid
            harness.env().ledger().timestamp() + 1000,
            &Bytes::new(harness.env()),
        );

        assert!(
            matches!(result, Err(KeeperError::InvalidReward)),
            "Should reject zero reward"
        );
    }
}
