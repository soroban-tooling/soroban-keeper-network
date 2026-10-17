//! High-level typed client for the Keeper Registry Soroban contract (Issues #333, #334, #340).

#![warn(missing_docs)]

use crate::error::CallContext;
use crate::retry::{default_classify, ErrorClass, RetryPolicy, RpcCallError, TransportError};
use crate::signing::TransactionSigner;
pub use crate::types::{BatchTaskParams, PendingCredit, SlashRecord, Task, UnbondRequest};
use keeper_registry::KeeperError;
use soroban_sdk::xdr::ScVal;
use soroban_sdk::{Address, Bytes, Env, IntoVal, Symbol, TryFromVal, TryIntoVal, Val, Vec};
use std::future::Future;
use std::time::Duration;

/// High-level client wrapping all contract interactions for integrators and keepers.
pub struct KeeperClient<'a, S: TransactionSigner> {
    /// Soroban host environment used for contract invocation and decoding.
    pub env: &'a Env,
    /// Address of the deployed keeper registry contract.
    pub contract_id: Address,
    /// Signer whose address authorizes state-changing calls.
    pub signer: &'a S,
}

impl<'a, S: TransactionSigner> KeeperClient<'a, S> {
    /// Create an in-process client for `contract_id` using `signer`.
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
            .map_err(contract_call_err(
                "batch_register_tasks",
                crate::call_args![&self.signer.address(), &tasks, &max_total_reward],
            ))?
            .map_err(contract_call_err(
                "batch_register_tasks",
                crate::call_args![&self.signer.address(), &tasks, &max_total_reward],
            ))
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

    /// Retrieve a keeper's reputation score.
    pub fn keeper_reputation(&self, keeper: &Address) -> u32 {
        self.env.invoke_contract(
            &self.contract_id,
            &soroban_sdk::Symbol::new(self.env, "keeper_reputation"),
            soroban_sdk::vec![self.env, keeper.to_val()],
        )
    }

    // ── Issue #334: Admin Entry Points ───────────────────────────────────────

    /// Initialize the contract with admin address, reward token, and fee basis points.
    pub fn initialize(&self, reward_token: &Address, fee_bps: u32) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_initialize(&self.signer.address(), reward_token, &fee_bps)
            .map_err(contract_call_err(
                "initialize",
                crate::call_args![&self.signer.address(), reward_token, &fee_bps],
            ))?
            .map_err(contract_call_err(
                "initialize",
                crate::call_args![&self.signer.address(), reward_token, &fee_bps],
            ))
    }

    /// Emergency pause toggle.
    pub fn pause(&self) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_pause(&self.signer.address())
            .map_err(contract_call_err(
                "pause",
                crate::call_args![&self.signer.address()],
            ))?
            .map_err(contract_call_err(
                "pause",
                crate::call_args![&self.signer.address()],
            ))
    }

    /// Emergency unpause toggle.
    pub fn unpause(&self) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_unpause(&self.signer.address())
            .map_err(contract_call_err(
                "unpause",
                crate::call_args![&self.signer.address()],
            ))?
            .map_err(contract_call_err(
                "unpause",
                crate::call_args![&self.signer.address()],
            ))
    }

    /// Update platform fee in basis points.
    pub fn set_fee_bps(&self, new_fee_bps: u32) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_fee_bps(&self.signer.address(), &new_fee_bps)
            .map_err(contract_call_err(
                "set_fee_bps",
                crate::call_args![&self.signer.address(), &new_fee_bps],
            ))?
            .map_err(contract_call_err(
                "set_fee_bps",
                crate::call_args![&self.signer.address(), &new_fee_bps],
            ))
    }

    /// Update minimum reward floor.
    pub fn set_min_reward(&self, min_reward: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_min_reward(&self.signer.address(), &min_reward)
            .map_err(contract_call_err(
                "set_min_reward",
                crate::call_args![&self.signer.address(), &min_reward],
            ))?
            .map_err(contract_call_err(
                "set_min_reward",
                crate::call_args![&self.signer.address(), &min_reward],
            ))
    }

    /// Sweep accrued protocol fees to recipient.
    pub fn sweep_fees(&self, recipient: &Address, amount: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_sweep_fees(&self.signer.address(), recipient, &amount)
            .map_err(contract_call_err(
                "sweep_fees",
                crate::call_args![&self.signer.address(), recipient, &amount],
            ))?
            .map_err(contract_call_err(
                "sweep_fees",
                crate::call_args![&self.signer.address(), recipient, &amount],
            ))
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
            .map_err(contract_call_err(
                "stake_deposit",
                crate::call_args![&self.signer.address(), &amount],
            ))?
            .map_err(contract_call_err(
                "stake_deposit",
                crate::call_args![&self.signer.address(), &amount],
            ))
    }

    /// Starts the unbonding delay for `amount` of the signer's bonded stake.
    /// Only one unbond request may be pending at a time; withdraw it first
    /// via [`Self::withdraw_stake`] before starting another.
    pub fn initiate_unbond(&self, amount: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_initiate_unbond(&self.signer.address(), &amount)
            .map_err(contract_call_err(
                "initiate_unbond",
                crate::call_args![&self.signer.address(), &amount],
            ))?
            .map_err(contract_call_err(
                "initiate_unbond",
                crate::call_args![&self.signer.address(), &amount],
            ))
    }

    /// Releases the signer's pending unbond request once its delay has
    /// elapsed, transferring the amount back to the signer. Returns the
    /// amount withdrawn.
    pub fn withdraw_stake(&self) -> Result<i128, ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_withdraw_stake(&self.signer.address())
            .map_err(contract_call_err(
                "withdraw_stake",
                crate::call_args![&self.signer.address()],
            ))?
            .map_err(contract_call_err(
                "withdraw_stake",
                crate::call_args![&self.signer.address()],
            ))
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
            .map_err(contract_call_err(
                "slash",
                crate::call_args![&self.signer.address(), keeper, &amount, &reason, treasury],
            ))?
            .map_err(contract_call_err(
                "slash",
                crate::call_args![&self.signer.address(), keeper, &amount, &reason, treasury],
            ))
    }

    /// Raises the signer's own appeal against a slash it was subject to.
    /// Only the slashed keeper may appeal, and only once per slash.
    pub fn raise_slash_appeal(&self, slash_id: u64) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_raise_slash_appeal(&self.signer.address(), &slash_id)
            .map_err(contract_call_err(
                "raise_slash_appeal",
                crate::call_args![&self.signer.address(), &slash_id],
            ))?
            .map_err(contract_call_err(
                "raise_slash_appeal",
                crate::call_args![&self.signer.address(), &slash_id],
            ))
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
            .map_err(contract_call_err(
                "resolve_slash_appeal",
                crate::call_args![&self.signer.address(), &slash_id, &uphold_appeal],
            ))?
            .map_err(contract_call_err(
                "resolve_slash_appeal",
                crate::call_args![&self.signer.address(), &slash_id, &uphold_appeal],
            ))
    }

    /// Admin-only: sets the minimum bonded stake `claim_task` requires (`0`
    /// disables the requirement).
    pub fn set_min_stake(&self, min_stake: i128) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_min_stake(&self.signer.address(), &min_stake)
            .map_err(contract_call_err(
                "set_min_stake",
                crate::call_args![&self.signer.address(), &min_stake],
            ))?
            .map_err(contract_call_err(
                "set_min_stake",
                crate::call_args![&self.signer.address(), &min_stake],
            ))
    }

    /// Admin-only: sets the ledger hold `execute_task` credits sit in
    /// before becoming withdrawable (`0` disables the dispute window,
    /// restoring immediate withdrawability). See
    /// docs/STAKING_DESIGN.md §4.2.
    pub fn set_dispute_window(&self, ledgers: u32) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_set_dispute_window(&self.signer.address(), &ledgers)
            .map_err(contract_call_err(
                "set_dispute_window",
                crate::call_args![&self.signer.address(), &ledgers],
            ))?
            .map_err(contract_call_err(
                "set_dispute_window",
                crate::call_args![&self.signer.address(), &ledgers],
            ))
    }

    /// Disputes a task's still-pending execution credit. Only the task's
    /// owner may call this, and only before the dispute window closes.
    pub fn dispute_execution(&self, task_id: u64) -> Result<(), ClientError> {
        let raw_client = keeper_registry::KeeperRegistryClient::new(self.env, &self.contract_id);
        raw_client
            .try_dispute_execution(&self.signer.address(), &task_id)
            .map_err(contract_call_err(
                "dispute_execution",
                crate::call_args![&self.signer.address(), &task_id],
            ))?
            .map_err(contract_call_err(
                "dispute_execution",
                crate::call_args![&self.signer.address(), &task_id],
            ))
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
            .map_err(contract_call_err(
                "resolve_execution_dispute",
                crate::call_args![&self.signer.address(), &task_id, &uphold_dispute],
            ))?
            .map_err(contract_call_err(
                "resolve_execution_dispute",
                crate::call_args![&self.signer.address(), &task_id, &uphold_dispute],
            ))
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
/// Errors produced by the in-process [`KeeperClient`].
pub enum ClientError {
    /// The contract host or contract implementation rejected an invocation.
    #[error("Contract call failed: {0}")]
    ContractError(String),
    /// The configured signer could not sign the invocation payload.
    #[error("Signer error: {0}")]
    SigningFailed(#[from] crate::signing::SignerError),
    /// Any of the above, wrapped with which call produced it (issue #345).
    #[error("{context}: {source}")]
    InCall {
        /// Method name and redacted argument diagnostics for the failed call.
        context: CallContext,
        /// Underlying client failure.
        #[source]
        source: Box<ClientError>,
    },
}

impl ClientError {
    /// Attach a call context, once: a context already attached wins, so
    /// plumbing shared between methods cannot stack a second frame.
    fn in_call(self, context: CallContext) -> Self {
        match self {
            Self::InCall { .. } => self,
            other => Self::InCall {
                context,
                source: Box::new(other),
            },
        }
    }

    /// The underlying error, with any call context unwrapped — match on
    /// this where the variant matters more than the call site.
    pub fn root(&self) -> &ClientError {
        match self {
            Self::InCall { source, .. } => source.root(),
            other => other,
        }
    }

    /// The failing call, when context was attached.
    pub fn context(&self) -> Option<&CallContext> {
        match self {
            Self::InCall { context, .. } => Some(context),
            _ => None,
        }
    }
}

fn alloc_format_error<E: core::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

/// `map_err` closure attaching both the decoded contract error and the call
/// context (issue #345). Built before the call so the argument debug forms
/// are captured exactly as passed; the signer itself is configuration, not
/// an argument, and is never formatted (only its public address is, where a
/// method passes it to the contract).
fn contract_call_err<E: core::fmt::Debug>(
    method: &'static str,
    args: std::vec::Vec<String>,
) -> impl Fn(E) -> ClientError {
    move |e| {
        ClientError::ContractError(alloc_format_error(e))
            .in_call(CallContext::new(method, args.clone()))
    }
}

// ── Issue #267: RPC-backed KeeperRegistryClient ──────────────────────────────
//
// `KeeperClient` above drives the contract in-process through a soroban
// `Env` (tests, contract-to-contract). `KeeperRegistryClient` is the
// network-facing counterpart: it owns the build -> simulate -> sign -> submit
// flow once (`read` / `write`) and every typed method is a thin wrapper over
// it. Contract shapes (`Task`, `TaskType`, `TaskStatus`, `KeeperError`) are
// the `keeper_registry` types themselves; nothing is redefined here.

/// A contract invocation, handed to an [`RpcTransport`] to simulate or submit.
#[derive(Debug, Clone, PartialEq)]
pub struct InvocationRequest {
    /// Strkey contract id (`C...`) of the keeper registry.
    pub contract_id: String,
    /// Contract function name.
    pub function: String,
    /// Positional arguments, already encoded as `ScVal`.
    pub args: std::vec::Vec<ScVal>,
    /// Network passphrase the transport must use when building the envelope.
    pub network_passphrase: String,
}

/// What a simulation returns: the call's decoded return value plus the
/// transaction the transport assembled (footprint, resource fee, auth
/// entries) that a mutating call must sign.
#[derive(Debug, Clone, PartialEq)]
pub struct SimulationOutcome {
    /// XDR return value produced by contract simulation.
    pub return_value: ScVal,
    /// Bytes handed to [`TransactionSigner::sign_payload`]. Building the
    /// envelope and the network-id-prefixed signature payload is the
    /// transport's job, since only it talks to the RPC node.
    pub transaction: std::vec::Vec<u8>,
}

/// A simulated transaction plus the signer's signature over it.
#[derive(Debug, Clone, PartialEq)]
pub struct SignedTransaction {
    /// Invocation whose simulated transaction was signed.
    pub request: InvocationRequest,
    /// Simulated transaction envelope or signature payload bytes.
    pub transaction: std::vec::Vec<u8>,
    /// Signature bytes returned by the configured signer.
    pub signature: std::vec::Vec<u8>,
}

/// The RPC layer `KeeperRegistryClient` runs on. Implement it over a Soroban
/// RPC node (the crate does not bundle an HTTP client; see the README), or
/// over an in-process `Env` for tests.
///
/// Failures use [`RpcCallError`]: `Transport` when the call never ran the
/// contract (retried per the client's [`RetryPolicy`]), `Contract(code)` when
/// the contract returned a `#[contracterror]` code, which the client decodes
/// into [`KeeperError`] and never retries.
pub trait RpcTransport {
    /// Simulate an invocation and return its value and assembled transaction.
    fn simulate(
        &self,
        request: &InvocationRequest,
    ) -> impl Future<Output = Result<SimulationOutcome, RpcCallError<u32>>> + Send;

    /// Submit a signed transaction and return its contract result value.
    fn submit(
        &self,
        signed: &SignedTransaction,
    ) -> impl Future<Output = Result<ScVal, RpcCallError<u32>>> + Send;

    /// Backoff sleep between retried simulations. The crate bundles no async
    /// runtime, so the default blocks the thread; override it with your
    /// runtime's timer (e.g. `tokio::time::sleep`).
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + Send {
        async move { std::thread::sleep(duration) }
    }
}

/// Errors from [`KeeperRegistryClient`].
///
/// `Contract` is actionable and usually expected (the contract rejected the
/// call: do not retry). `Transport` means the network failed before the
/// contract ran (usually worth retrying; the client already did per its
/// policy). `Decode` means a response arrived but was not the expected shape.
#[derive(Debug, thiserror::Error)]
pub enum RegistryClientError {
    /// A known keeper-registry contract error.
    #[error("contract rejected the call: {0:?}")]
    Contract(KeeperError),
    /// A contract error code not represented by this SDK version.
    #[error("contract returned unknown error code {0}")]
    UnknownContractError(u32),
    /// RPC transport failed before a usable result was returned.
    #[error("RPC transport failure: {0:?}")]
    Transport(TransportError),
    /// A successful RPC response did not match the method's expected type.
    #[error("could not decode response: {0}")]
    Decode(String),
    /// A mutating call was attempted without a configured signer.
    #[error("no signer configured; call `with_signer` before a mutating call")]
    NoSigner,
    /// The configured signer failed to sign the simulated transaction.
    #[error("signing failed: {0}")]
    Signing(#[from] crate::signing::SignerError),
    /// Any of the above, wrapped with which call produced it (issue #345).
    /// `read` and `write` attach it, so every typed method - and any direct
    /// `read`/`write` caller - gets it for free.
    #[error("{context}: {source}")]
    InCall {
        /// Method name and redacted argument diagnostics for the failed call.
        context: CallContext,
        /// Underlying registry-client failure.
        #[source]
        source: Box<RegistryClientError>,
    },
}

impl RegistryClientError {
    /// Attach a call context, once: the innermost attachment (the method
    /// that actually ran) wins over any outer plumbing.
    fn in_call(self, context: CallContext) -> Self {
        match self {
            Self::InCall { .. } => self,
            other => Self::InCall {
                context,
                source: Box::new(other),
            },
        }
    }

    /// The underlying error, with any call context unwrapped - match on
    /// this where the variant matters more than the call site.
    pub fn root(&self) -> &RegistryClientError {
        match self {
            Self::InCall { source, .. } => source.root(),
            other => other,
        }
    }

    /// The failing call, when context was attached.
    pub fn context(&self) -> Option<&CallContext> {
        match self {
            Self::InCall { context, .. } => Some(context),
            _ => None,
        }
    }
}

impl From<RpcCallError<u32>> for RegistryClientError {
    fn from(err: RpcCallError<u32>) -> Self {
        match err {
            RpcCallError::Transport(t) => Self::Transport(t),
            RpcCallError::Contract(code) => {
                match KeeperError::try_from(soroban_sdk::Error::from_contract_error(code)) {
                    Ok(e) => Self::Contract(e),
                    Err(_) => Self::UnknownContractError(code),
                }
            }
        }
    }
}

/// Network-facing client for the keeper registry contract.
pub struct KeeperRegistryClient<T: RpcTransport> {
    contract_id: String,
    rpc_url: String,
    network_passphrase: String,
    transport: T,
    retry: RetryPolicy,
    signer: Option<Box<dyn TransactionSigner>>,
    // Only used to decode returned values into contract types.
    env: Env,
}

impl<T: RpcTransport> KeeperRegistryClient<T> {
    /// `contract_id`, `rpc_url` and `network_passphrase` identify the
    /// deployment; `transport` performs the RPC calls against `rpc_url`.
    pub fn new(
        contract_id: impl Into<String>,
        rpc_url: impl Into<String>,
        network_passphrase: impl Into<String>,
        transport: T,
    ) -> Self {
        Self {
            contract_id: contract_id.into(),
            rpc_url: rpc_url.into(),
            network_passphrase: network_passphrase.into(),
            transport,
            retry: RetryPolicy::default(),
            signer: None,
            env: Env::default(),
        }
    }

    /// Signer used by mutating calls; also the `admin` / `owner` / `keeper`
    /// argument the typed write methods pass.
    pub fn with_signer(mut self, signer: impl TransactionSigner + 'static) -> Self {
        self.signer = Some(Box::new(signer));
        self
    }

    /// Overrides the default retry policy (applied to simulation; submission
    /// is never retried, since a lost response may mean it already landed).
    pub fn with_retry_policy(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// Deployed registry contract id used by this client.
    pub fn contract_id(&self) -> &str {
        &self.contract_id
    }

    /// Soroban RPC endpoint associated with this client.
    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// Network passphrase used when assembling transaction signatures.
    pub fn network_passphrase(&self) -> &str {
        &self.network_passphrase
    }

    fn request(&self, function: &str, args: std::vec::Vec<ScVal>) -> InvocationRequest {
        InvocationRequest {
            contract_id: self.contract_id.clone(),
            function: function.to_string(),
            args,
            network_passphrase: self.network_passphrase.clone(),
        }
    }

    fn decode<R: TryFromVal<Env, Val>>(&self, value: &ScVal) -> Result<R, RegistryClientError> {
        let val = Val::try_from_val(&self.env, value)
            .map_err(|e| RegistryClientError::Decode(format!("{e:?}")))?;
        R::try_from_val(&self.env, &val)
            .map_err(|_| RegistryClientError::Decode(format!("unexpected value {value:?}")))
    }

    fn encode<V: IntoVal<Env, Val>>(&self, value: V) -> Result<ScVal, RegistryClientError> {
        let value: Val = value.into_val(&self.env);
        value
            .try_into_val(&self.env)
            .map_err(|e| RegistryClientError::Decode(format!("could not encode argument: {e:?}")))
    }

    async fn simulate(
        &self,
        request: &InvocationRequest,
    ) -> Result<SimulationOutcome, RegistryClientError> {
        // Same policy and classifier as `RetryPolicy::run`, written out here
        // because `run` needs `'static` futures and a transport future
        // borrows the client.
        let mut attempt = 0;
        loop {
            match self.transport.simulate(request).await {
                Ok(outcome) => return Ok(outcome),
                Err(err) => {
                    let last = attempt + 1 >= self.retry.max_attempts;
                    if matches!(default_classify(&err), ErrorClass::Permanent) || last {
                        return Err(err.into());
                    }
                    self.transport.sleep(self.retry.delay_for(attempt)).await;
                    attempt += 1;
                }
            }
        }
    }

    /// Shared read plumbing: simulate only, decode the return value.
    pub async fn read<R: TryFromVal<Env, Val>>(
        &self,
        function: &'static str,
        args: std::vec::Vec<ScVal>,
    ) -> Result<R, RegistryClientError> {
        // Captured before the call, so the error names exactly what was sent
        // (issue #345). `ScVal` arguments never include the signer or any
        // other key material, so their debug form is safe to keep.
        let context = CallContext::from_debug(function, &args);
        let result: Result<R, RegistryClientError> = async {
            let outcome = self.simulate(&self.request(function, args)).await?;
            self.decode(&outcome.return_value)
        }
        .await;
        result.map_err(|e| e.in_call(context))
    }

    /// Shared mutating plumbing: simulate, sign the assembled transaction
    /// with the configured signer, submit, decode the result.
    pub async fn write<R: TryFromVal<Env, Val>>(
        &self,
        function: &'static str,
        args: std::vec::Vec<ScVal>,
    ) -> Result<R, RegistryClientError> {
        // Captured before the call (issue #345). Only the contract arguments
        // are recorded: the signer is configuration, and a signing failure's
        // context names the call without ever formatting the signer itself.
        let context = CallContext::from_debug(function, &args);
        let result: Result<R, RegistryClientError> = async {
            let signer = self.signer.as_ref().ok_or(RegistryClientError::NoSigner)?;
            let request = self.request(function, args);
            let outcome = self.simulate(&request).await?;
            let signature = signer.sign_payload(&outcome.transaction)?;
            let signed = SignedTransaction {
                request,
                transaction: outcome.transaction,
                signature: signature.iter().collect(),
            };
            let result = self.transport.submit(&signed).await?;
            self.decode(&result)
        }
        .await;
        result.map_err(|e| e.in_call(context))
    }

    fn signer_arg(&self) -> Result<ScVal, RegistryClientError> {
        let signer = self.signer.as_ref().ok_or(RegistryClientError::NoSigner)?;
        Ok(ScVal::from(signer.address()))
    }

    // ── typed methods (thin wrappers over `read` / `write`) ──

    /// Fetches a task. `Task` carries `TaskType` and `TaskStatus` from the
    /// contract crate directly.
    pub async fn get_task(&self, task_id: u64) -> Result<Task, RegistryClientError> {
        self.read("get_task", vec![ScVal::U64(task_id)]).await
    }

    /// Platform fee in basis points.
    pub async fn get_fee_bps(&self) -> Result<u32, RegistryClientError> {
        self.read("get_fee_bps", vec![]).await
    }

    /// Whether the contract is paused.
    pub async fn is_paused(&self) -> Result<bool, RegistryClientError> {
        self.read("is_paused", vec![]).await
    }

    /// Admin-only: updates the platform fee. Signed by the configured signer.
    pub async fn set_fee_bps(&self, new_bps: u32) -> Result<(), RegistryClientError> {
        let admin = self
            .signer_arg()
            .map_err(|e| e.in_call(CallContext::new("set_fee_bps", crate::call_args![new_bps])))?;
        self.write("set_fee_bps", vec![admin, ScVal::U32(new_bps)])
            .await
    }

    /// Register and fund a new task for the configured signer.
    #[allow(clippy::too_many_arguments)]
    pub async fn register_task(
        &self,
        task_type: crate::types::TaskType,
        calldata: Bytes,
        reward: i128,
        deadline: u64,
        ttl_ledgers: u32,
        lock_ledgers: u32,
        verifier: Option<Address>,
    ) -> Result<u64, RegistryClientError> {
        let owner = self.signer_arg().map_err(|e| {
            e.in_call(CallContext::new(
                "register_task",
                crate::call_args![reward, deadline, ttl_ledgers, lock_ledgers],
            ))
        })?;
        self.write(
            "register_task",
            vec![
                owner,
                self.encode(task_type)?,
                self.encode(calldata)?,
                ScVal::I128(soroban_sdk::xdr::Int128Parts {
                    hi: (reward >> 64) as i64,
                    lo: reward as u64,
                }),
                ScVal::U64(deadline),
                ScVal::U32(ttl_ledgers),
                ScVal::U32(lock_ledgers),
                self.encode(verifier)?,
            ],
        )
        .await
    }

    /// Claim a pending task for the configured signer.
    pub async fn claim_task(&self, task_id: u64) -> Result<(), RegistryClientError> {
        let keeper = self
            .signer_arg()
            .map_err(|e| e.in_call(CallContext::new("claim_task", crate::call_args![task_id])))?;
        self.write("claim_task", vec![keeper, ScVal::U64(task_id)])
            .await
    }

    /// Execute a claimed task and submit its proof as the configured signer.
    pub async fn execute_task(
        &self,
        task_id: u64,
        proof: Bytes,
    ) -> Result<(), RegistryClientError> {
        let keeper = self
            .signer_arg()
            .map_err(|e| e.in_call(CallContext::new("execute_task", crate::call_args![task_id])))?;
        self.write(
            "execute_task",
            vec![keeper, ScVal::U64(task_id), self.encode(proof)?],
        )
        .await
    }

    /// Withdraw the configured signer's accrued keeper rewards.
    pub async fn withdraw_rewards(&self) -> Result<i128, RegistryClientError> {
        let keeper = self
            .signer_arg()
            .map_err(|e| e.in_call(CallContext::new("withdraw_rewards", std::vec::Vec::new())))?;
        self.write("withdraw_rewards", vec![keeper]).await
    }
}
