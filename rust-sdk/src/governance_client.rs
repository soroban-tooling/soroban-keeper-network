//! High-level typed client for the Governance Soroban contract.
//!
//! Mirrors `rust-sdk/src/treasury_client.rs` and `rust-sdk/src/client.rs` shapes,
//! providing strongly-typed entrypoints, views, and contract error decoding.

use crate::client::ClientError;
use crate::signing::TransactionSigner;
use soroban_sdk::{Address, Env};
pub use governance::{
    GovernableAction, GovernanceContractClient, GovernanceError, Proposal, ProposalStatus, VERSION,
};

fn alloc_format_error<E: core::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

/// Decodes typed `GovernanceError` from a `ClientError` if available.
pub fn decode_governance_error(err: &ClientError) -> Option<GovernanceError> {
    let s = match err.root() {
        ClientError::ContractError(msg) => msg.as_str(),
        _ => return None,
    };
    if s.contains("AlreadyInitialized") {
        Some(GovernanceError::AlreadyInitialized)
    } else if s.contains("Unauthorized") {
        Some(GovernanceError::Unauthorized)
    } else if s.contains("NotInitialized") {
        Some(GovernanceError::NotInitialized)
    } else if s.contains("ProposalNotFound") {
        Some(GovernanceError::ProposalNotFound)
    } else if s.contains("ProposalAlreadyExecuted") {
        Some(GovernanceError::ProposalAlreadyExecuted)
    } else if s.contains("ProposalNotQueued") {
        Some(GovernanceError::ProposalNotQueued)
    } else if s.contains("TimelockNotElapsed") {
        Some(GovernanceError::TimelockNotElapsed)
    } else if s.contains("RegistryCallFailed") {
        Some(GovernanceError::RegistryCallFailed)
    } else {
        None
    }
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

    /// Access the raw generated contract client.
    pub fn raw(&self) -> GovernanceContractClient<'_> {
        GovernanceContractClient::new(self.env, &self.contract_id)
    }

    /// Initializes the governance contract with admin, KPRS token address, and registry address.
    pub fn initialize(&self, kprs_token: &Address, registry: &Address) -> Result<(), ClientError> {
        self.raw()
            .try_initialize(&self.signer.address(), kprs_token, registry)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Creates and queues a proposal for execution after the specified timelock ETA.
    pub fn create_proposal(
        &self,
        action: &GovernableAction,
        eta: u64,
    ) -> Result<u64, ClientError> {
        self.raw()
            .try_create_proposal(&self.signer.address(), action, &eta)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Casts a vote on an active proposal.
    pub fn vote(&self, proposal_id: u64, support: u32) -> Result<(), ClientError> {
        self.raw()
            .try_vote(&self.signer.address(), &proposal_id, &support)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Executes a passed, queued proposal whose timelock has elapsed against the registry.
    pub fn execute_proposal(&self, proposal_id: u64) -> Result<(), ClientError> {
        self.raw()
            .try_execute_proposal(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    // ── Read-only views ──────────────────────────────────────────────────────

    /// Semantic version of the governance contract logic.
    pub fn version(&self) -> u32 {
        self.raw().version()
    }

    /// Returns the contract admin address.
    pub fn admin(&self) -> Result<Address, ClientError> {
        self.raw()
            .try_admin()
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Returns the configured KPRS governance token address.
    pub fn kprs_token(&self) -> Result<Address, ClientError> {
        self.raw()
            .try_kprs_token()
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Returns the configured KeeperRegistry address.
    pub fn registry(&self) -> Result<Address, ClientError> {
        self.raw()
            .try_registry()
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Reads voting power from the configured KPRS token contract for an account.
    pub fn get_voting_power(&self, account: &Address) -> Result<i128, ClientError> {
        self.raw()
            .try_get_voting_power(account)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Retrieves a proposal by its unique ID.
    pub fn get_proposal(&self, proposal_id: u64) -> Result<Proposal, ClientError> {
        self.raw()
            .try_get_proposal(&proposal_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }
}
