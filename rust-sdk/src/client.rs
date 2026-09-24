//! High-level typed client for the Keeper Registry Soroban contract (Issues #333, #334, #340).

use crate::signing::TransactionSigner;
pub use crate::types::{BatchTaskParams, PendingCredit, SlashRecord, Task, UnbondRequest};
use soroban_sdk::{Address, Env, Symbol, Vec};

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
    pub fn initialize(&self, reward_token: &Address, fee_bps: u32) -> Result<(), ClientError> {
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

    // ── Issue #428: Staking & Slashing Entry Points (epic E06) ───────────────
    //
    // Wraps the entry points and views from backlog 0289 (stake storage),
    // 0290 (unbonding), 0291 (slash), and 0297 (staking views), plus the
    // execution dispute window this same epic introduced
    // (docs/STAKING_DESIGN.md §4.2). Follows issue 0206's admin-method
    // discipline: one method per entry point on this same client struct (no
    // separate "StakingClient"), every argument typed exactly as the
    // contract declares it, and errors routed through the existing
    // `ClientError::ContractError` path so `KeeperError`'s new staking
    // variants (InsufficientStake..NotSlashedKeeper, NoPendingCredit..
    // NoDisputedCredit) are reachable the same way every other contract
    // error already is, rather than introducing a parallel error type.

    /// Deposits `amount` of the reward token as the signer's bonded stake.
    pub fn stake_deposit(&self, amount: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_stake_deposit(&self.signer.address(), &amount)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Starts the unbonding delay for `amount` of the signer's bonded stake.
    /// Only one unbond request may be pending at a time; withdraw it first
    /// via [`Self::withdraw_stake`] before starting another.
    pub fn initiate_unbond(&self, amount: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_initiate_unbond(&self.signer.address(), &amount)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Releases the signer's pending unbond request once its delay has
    /// elapsed, transferring the amount back to the signer. Returns the
    /// amount withdrawn.
    pub fn withdraw_stake(&self) -> Result<i128, ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_withdraw_stake(&self.signer.address())
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: slashes `amount` of `keeper`'s bonded stake for
    /// off-chain-determined misbehavior, moving it to `treasury`. Returns a
    /// `slash_id` for later reference by [`Self::raise_slash_appeal`].
    pub fn slash(
        &self,
        keeper: &Address,
        amount: i128,
        reason: Symbol,
        treasury: &Address,
    ) -> Result<u64, ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_slash(&self.signer.address(), keeper, &amount, &reason, treasury)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Raises the signer's own appeal against a slash it was subject to.
    /// Only the slashed keeper may appeal, and only once per slash.
    pub fn raise_slash_appeal(&self, slash_id: u64) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_raise_slash_appeal(&self.signer.address(), &slash_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: resolves a raised slash appeal, either upholding it
    /// (restoring the slashed stake, re-funded from the signer) or
    /// rejecting it (the slash stands).
    pub fn resolve_slash_appeal(
        &self,
        slash_id: u64,
        uphold_appeal: bool,
    ) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_resolve_slash_appeal(&self.signer.address(), &slash_id, &uphold_appeal)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: sets the minimum bonded stake `claim_task` requires (`0`
    /// disables the requirement).
    pub fn set_min_stake(&self, min_stake: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_min_stake(&self.signer.address(), &min_stake)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: sets the ledger hold `execute_task` credits sit in
    /// before becoming withdrawable (`0` disables the dispute window,
    /// restoring immediate withdrawability). See
    /// docs/STAKING_DESIGN.md §4.2.
    pub fn set_dispute_window(&self, ledgers: u32) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_dispute_window(&self.signer.address(), &ledgers)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Disputes a task's still-pending execution credit. Only the task's
    /// owner may call this, and only before the dispute window closes.
    pub fn dispute_execution(&self, task_id: u64) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_dispute_execution(&self.signer.address(), &task_id)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    /// Admin-only: resolves a disputed execution credit, either upholding
    /// the dispute (the keeper is never paid; the forfeited reward accrues
    /// to protocol fees) or rejecting it (the credit finalizes normally).
    pub fn resolve_execution_dispute(
        &self,
        task_id: u64,
        uphold_dispute: bool,
    ) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_resolve_execution_dispute(&self.signer.address(), &task_id, &uphold_dispute)
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))?
            .map_err(|e| ClientError::ContractError(alloc_format_error(e)))
    }

    // ── Issue #428 / backlog 0297: staking read-only views ───────────────────
    //
    // Views never fail against an initialized contract (see views.rs's
    // policy doc comment), so these return the raw typed value directly
    // rather than `Result<_, ClientError>`, matching `get_tasks`/
    // `get_tasks_range` above rather than the state-mutating methods.

    /// The keeper's currently-bonded stake (0 if it has never staked).
    /// Excludes anything mid-unbond — see [`Self::pending_unbond`].
    pub fn keeper_stake(&self, keeper: &Address) -> i128 {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.keeper_stake(keeper)
    }

    /// The keeper's pending unbond request, if any.
    pub fn pending_unbond(&self, keeper: &Address) -> Option<UnbondRequest> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.pending_unbond(keeper)
    }

    /// The minimum bonded stake `claim_task` currently requires (0 if
    /// unset).
    pub fn min_stake(&self) -> i128 {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.min_stake()
    }

    /// A specific slash record by id, if it still exists (a resolved
    /// appeal removes its record).
    pub fn get_slash(&self, slash_id: u64) -> Option<SlashRecord> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.get_slash(&slash_id)
    }

    /// Ledgers an `execute_task` credit is held before it becomes
    /// withdrawable (0 if unset, meaning disabled).
    pub fn dispute_window(&self) -> u32 {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.dispute_window()
    }

    /// The keeper's not-yet-finalized `execute_task` credits.
    pub fn pending_reward(&self, keeper: &Address) -> Vec<PendingCredit> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client.pending_reward(keeper)
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
