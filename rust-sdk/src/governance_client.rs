//! High-level typed client for the Governance Soroban contract (Issue #503).
//!
//! Mirrors `rust-sdk/src/treasury_client.rs` and `rust-sdk/src/client.rs`,
//! following the SDK's client conventions and wrapping all governance entry points
//! and views with typed parameters, error handling, and `CallContext`.

use crate::client::ClientError;
use crate::signing::TransactionSigner;
pub use governance::{
    GovernableAction, GovernanceError, Proposal, ProposalStatus, VoteChoice, VoteRecord,
};
use soroban_sdk::{Address, Env};

fn alloc_format_error<E: core::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

/// High-level client wrapping all governance contract interactions.
pub struct GovernanceClient<'a, S: TransactionSigner> {
    pub env: &'a Env,
    pub contract_id: Address,
    pub signer: &'a S,
}

impl<'a, S: TransactionSigner> GovernanceClient<'a, S> {
    pub fn new(env: &'a Env, contract_id: Address, signer: &'a S) -> Self {
        Self {
            env,
            contract_id,
            signer,
        }
    }

    fn raw(&self) -> governance::GovernanceContractClient<'_> {
        governance::GovernanceContractClient::new(self.env, &self.contract_id)
    }

    /// Initialize the governance contract with an admin, KPRS governance token, and registry address.
    pub fn initialize(&self, kprs_token: &Address, registry: &Address) -> Result<(), ClientError> {
        self.raw()
            .try_initialize(&self.signer.address(), kprs_token, registry)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Creates a proposal against the closed list of governable parameters.
    pub fn create_proposal(&self, action: GovernableAction) -> Result<u64, ClientError> {
        self.raw()
            .try_create_proposal(&self.signer.address(), &action)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Cast a vote on an active proposal.
    pub fn vote(&self, proposal_id: u64, choice: VoteChoice) -> Result<(), ClientError> {
        self.raw()
            .try_vote(&self.signer.address(), &proposal_id, &choice)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Evaluates an open proposal once its voting period has ended.
    pub fn evaluate_proposal(&self, proposal_id: u64) -> Result<ProposalStatus, ClientError> {
        self.raw()
            .try_evaluate_proposal(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Queues a passed proposal for the configured timelock delay.
    pub fn queue_proposal(&self, proposal_id: u64) -> Result<u64, ClientError> {
        self.raw()
            .try_queue_proposal(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Executes a queued proposal after its timelock delay has elapsed.
    pub fn execute_proposal(&self, proposal_id: u64) -> Result<(), ClientError> {
        self.raw()
            .try_execute_proposal(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Cancels a proposal before execution (caller must be proposer or admin).
    pub fn cancel_proposal(&self, proposal_id: u64) -> Result<(), ClientError> {
        self.raw()
            .try_cancel_proposal(&self.signer.address(), &proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    // ── Read-only views ──────────────────────────────────────────────────────

    pub fn admin(&self) -> Address {
        self.raw().admin()
    }

    pub fn kprs_token(&self) -> Address {
        self.raw().kprs_token()
    }

    pub fn registry(&self) -> Address {
        self.raw().registry()
    }

    pub fn version(&self) -> u32 {
        self.raw().version()
    }

    pub fn proposal_count(&self) -> u64 {
        self.raw().proposal_count()
    }

    pub fn proposal_threshold(&self) -> i128 {
        self.raw().proposal_threshold()
    }

    pub fn voting_period(&self) -> u32 {
        self.raw().voting_period()
    }

    pub fn timelock_delay(&self) -> u32 {
        self.raw().timelock_delay()
    }

    pub fn quorum_bps(&self) -> u32 {
        self.raw().quorum_bps()
    }

    pub fn total_token_supply(&self) -> i128 {
        self.raw().total_token_supply()
    }

    pub fn quorum_threshold(&self) -> i128 {
        self.raw().quorum_threshold()
    }

    pub fn get_proposal(&self, proposal_id: u64) -> Result<Proposal, ClientError> {
        self.raw()
            .try_get_proposal(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn get_proposal_status(&self, proposal_id: u64) -> Result<ProposalStatus, ClientError> {
        self.raw()
            .try_get_proposal_status(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn get_proposal_state(&self, proposal_id: u64) -> Result<ProposalStatus, ClientError> {
        self.raw()
            .try_get_proposal_state(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn get_tallies(&self, proposal_id: u64) -> Result<(i128, i128, i128), ClientError> {
        self.raw()
            .try_get_tallies(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn has_voted(&self, proposal_id: u64, voter: &Address) -> bool {
        self.raw().has_voted(&proposal_id, voter)
    }

    pub fn get_vote(&self, proposal_id: u64, voter: &Address) -> Option<VoteRecord> {
        self.raw().get_vote(&proposal_id, voter)
    }

    pub fn get_voting_power(&self, account: &Address) -> Result<i128, ClientError> {
        self.raw()
            .try_get_voting_power(account)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn get_voting_power_at(&self, account: &Address, ledger: u32) -> Result<i128, ClientError> {
        self.raw()
            .try_get_voting_power_at(account, &ledger)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn is_executable(&self, proposal_id: u64) -> Result<bool, ClientError> {
        self.raw()
            .try_is_executable(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn is_quorum_met(&self, proposal_id: u64) -> Result<bool, ClientError> {
        self.raw()
            .try_is_quorum_met(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn is_passing_threshold_met(&self, proposal_id: u64) -> Result<bool, ClientError> {
        self.raw()
            .try_is_passing_threshold_met(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    pub fn get_remaining_delay(&self, proposal_id: u64) -> Result<u64, ClientError> {
        self.raw()
            .try_get_remaining_delay(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }
}
