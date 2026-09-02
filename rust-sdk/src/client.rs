//! High-level typed client for the Keeper Registry Soroban contract (Issues #333, #334, #340).

use soroban_sdk::{Address, Env, Vec};
use crate::signing::TransactionSigner;
pub use crate::types::{BatchTaskParams, Task};

/// High-level client wrapping all contract interactions for integrators and keepers.
pub struct KeeperClient<'a, S: TransactionSigner> {
    pub env: &'a Env,
    pub contract_id: Address,
    pub signer: &'a S,
}

impl<'a, S: TransactionSigner> KeeperClient<'a, S> {
    pub fn new(env: &'a Env, contract_id: Address, signer: &'a S) -> Self {
        Self {
            env,
            contract_id,
            signer,
        }
    }

    // ── Issue #333: Batch Operations & Range Queries ─────────────────────────

    /// Registers multiple tasks in a single atomic transaction under the signer's authorization.
    pub fn batch_register_tasks(
        &self,
        tasks: Vec<BatchTaskParams>,
        max_total_reward: i128,
    ) -> Result<Vec<u64>, ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_batch_register_tasks(&self.signer.address(), &tasks, &max_total_reward)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Retrieve full task state for an array of task IDs.
    pub fn get_tasks(&self, task_ids: Vec<u64>) -> Vec<Option<Task>> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.get_tasks(&task_ids)
    }

    /// Retrieve a contiguous slice of tasks from start_id up to limit.
    pub fn get_tasks_range(&self, start_id: u64, limit: u32) -> Vec<Option<Task>> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.get_tasks_range(&start_id, &limit)
    }

    // ── Issue #334: Admin Entry Points ───────────────────────────────────────

    /// Initialize the contract with admin address, reward token, and fee basis points.
    pub fn initialize(
        &self,
        reward_token: &Address,
        fee_bps: u32,
    ) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_initialize(&self.signer.address(), reward_token, &fee_bps)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Emergency pause toggle.
    pub fn pause(&self) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_pause(&self.signer.address())
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Emergency unpause toggle.
    pub fn unpause(&self) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_unpause(&self.signer.address())
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Update platform fee in basis points.
    pub fn set_fee_bps(&self, new_fee_bps: u32) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_fee_bps(&self.signer.address(), &new_fee_bps)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Update minimum reward floor.
    pub fn set_min_reward(&self, min_reward: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_min_reward(&self.signer.address(), &min_reward)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Sweep accrued protocol fees to recipient.
    pub fn sweep_fees(&self, recipient: &Address, amount: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_sweep_fees(&self.signer.address(), recipient, &amount)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Contract call failed: {0}")]
    ContractError(String),
    #[error("Signer error: {0}")]
    SigningFailed(#[from] crate::signing::SignerError),
}

fn alloc_format_error<E: core::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}
