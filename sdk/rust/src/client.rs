//! The real `KeeperRegistryClient` — invoke/read building blocks (this
//! module) plus the six task-lifecycle methods (`methods.rs`), per issue
//! 0268.
//!
//! Mirrors the TypeScript SDK's own design exactly: `invoke`/`read` are the
//! generic building blocks every specific contract call is built from, not
//! one hand-generated method per contract function — see
//! `packages/sdk-ts/src/client.ts`'s own doc comment for the same reasoning,
//! and this issue's own acceptance criteria, which explicitly ask for
//! consistency with the contract's own "too many arguments" philosophy
//! (`#[allow(clippy::too_many_arguments)]` on `register_task`) rather than
//! inventing a builder pattern that contradicts it.

// `soroban_client`'s crate root does `pub use stellar_baselib::*`, which
// re-exports stellar-baselib's own top-level `pub mod`s (not their inner
// items flatly) — so every stellar-baselib type/trait below is reached
// through its module path, e.g. `soroban_client::keypair::Keypair`, exactly
// as soroban-client's own `tests.rs` imports them (`use
// stellar_baselib::keypair::Keypair` there, since it depends on
// stellar-baselib directly; this crate only depends on soroban-client, so
// the equivalent path goes through soroban_client's re-export instead).
use soroban_client::contract::{ContractBehavior, Contracts};
use soroban_client::error::Error as SorobanClientError;
use soroban_client::keypair::{Keypair, KeypairBehavior};
use soroban_client::soroban_rpc::{GetTransactionResponse, TransactionStatus};
use soroban_client::transaction::TransactionBehavior;
use soroban_client::transaction_builder::{TransactionBuilder, TransactionBuilderBehavior};
use soroban_client::xdr::ScVal;
use soroban_client::{Options, Server};
use std::time::Duration;

use crate::network::Network;

/// How long [`KeeperRegistryClient::invoke`] waits for a submitted
/// transaction to reach a terminal status before giving up. Matches the
/// TypeScript SDK's own 30-attempt / 2-second poll loop (60 seconds total)
/// — see `client.ts`'s `invoke()`.
const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(60);

/// A transaction's own fee, before simulation adds the resource fee.
/// `prepare_transaction` (see below) adds the simulated resource cost on
/// top of this — this is deliberately a small, fixed base fee, not a guess
/// at the final fee the network will actually charge.
const BASE_FEE: u32 = 100;

#[derive(Debug)]
pub enum ClientError {
    /// The RPC client itself rejected the call (network error, malformed
    /// response, etc.) — see the wrapped `soroban_client::Error` for detail.
    Rpc(SorobanClientError),
    /// The transaction was submitted and confirmed, but the contract
    /// rejected it (or the host rejected it before invoking the contract).
    /// The message is Soroban's own diagnostic text — see `errors.rs`'
    /// TypeScript counterpart, `decodeKeeperError`, for the equivalent
    /// numeric-discriminant extraction this crate doesn't yet provide
    /// (tracked as a natural follow-up once this client has real callers).
    TransactionFailed(String),
    /// The transaction was submitted but never reached a terminal status
    /// within `CONFIRMATION_TIMEOUT`.
    ConfirmationTimedOut,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Rpc(err) => write!(f, "RPC error: {err:?}"),
            ClientError::TransactionFailed(msg) => write!(f, "transaction failed: {msg}"),
            ClientError::ConfirmationTimedOut => {
                write!(f, "transaction did not reach a terminal status in time")
            }
        }
    }
}

impl std::error::Error for ClientError {}

impl From<SorobanClientError> for ClientError {
    fn from(err: SorobanClientError) -> Self {
        ClientError::Rpc(err)
    }
}

pub struct KeeperRegistryClient {
    contract_id: String,
    network: Network,
    keypair: Keypair,
    server: Server,
}

impl KeeperRegistryClient {
    /// Constructs a client for `contract_id` on `network`, signing with
    /// `keypair`. Does not perform any network I/O itself — the RPC
    /// connection is only used on the first real call.
    pub fn new(
        contract_id: impl Into<String>,
        network: Network,
        keypair: Keypair,
    ) -> Result<Self, ClientError> {
        let server = Server::new(network.rpc_url(), Options::default())?;
        Ok(Self {
            contract_id: contract_id.into(),
            network,
            keypair,
            server,
        })
    }

    /// Like [`Self::new`], but against `rpc_url` instead of `network`'s own
    /// default public endpoint — for a local Soroban sandbox/quickstart
    /// node, or (in this crate's own test suite) a mocked RPC server.
    /// `network` still determines the passphrase transactions are signed
    /// against, since that's a property of the ledger being talked to, not
    /// of the URL.
    pub fn with_rpc_url(
        contract_id: impl Into<String>,
        network: Network,
        keypair: Keypair,
        rpc_url: &str,
    ) -> Result<Self, ClientError> {
        let server = Server::new(
            rpc_url,
            Options {
                allow_http: true,
                ..Default::default()
            },
        )?;
        Ok(Self {
            contract_id: contract_id.into(),
            network,
            keypair,
            server,
        })
    }

    pub fn contract_id(&self) -> &str {
        &self.contract_id
    }

    pub fn network(&self) -> &Network {
        &self.network
    }

    /// Simulates, signs, submits, and polls for confirmation of a contract
    /// call that mutates state — the same simulate → assemble → sign →
    /// send → poll sequence as the TypeScript SDK's `invoke()`.
    pub async fn invoke(
        &self,
        method: &str,
        args: Vec<ScVal>,
    ) -> Result<GetTransactionResponse, ClientError> {
        let mut source_account = self.server.get_account(&self.keypair.public_key()).await?;

        let contract = Contracts::new(&self.contract_id)
            .map_err(|msg| ClientError::TransactionFailed(msg.to_string()))?;
        let operation = contract.call(method, Some(args));

        let mut builder =
            TransactionBuilder::new(&mut source_account, self.network.passphrase(), None);
        builder.add_operation(operation);
        builder.fee(BASE_FEE);
        let tx = builder.build();

        // prepare_transaction simulates internally and returns a transaction
        // with the simulated resource fee and Soroban transaction data
        // already attached — equivalent to the TS SDK's separate
        // simulateTransaction + assembleTransaction steps combined.
        let mut prepared = self.server.prepare_transaction(&tx).await?;
        prepared.sign(std::slice::from_ref(&self.keypair));

        let send_result = self.server.send_transaction(prepared).await?;

        let confirmed = self
            .server
            .wait_transaction(&send_result.hash, CONFIRMATION_TIMEOUT)
            .await
            .map_err(|(err, _last)| ClientError::Rpc(err))?;

        match confirmed.status {
            TransactionStatus::Success => Ok(confirmed),
            TransactionStatus::Failed => Err(ClientError::TransactionFailed(format!(
                "transaction {} failed on-chain",
                send_result.hash
            ))),
            TransactionStatus::NotFound => Err(ClientError::ConfirmationTimedOut),
        }
    }

    /// Evaluates a read-only contract function via simulation. No
    /// transaction is signed, submitted, or confirmed, and no sequence
    /// number is consumed — equivalent to the TypeScript SDK's `read()`.
    ///
    /// Note: simulation still builds a transaction envelope, so the
    /// client's own account must already exist (be funded) on-chain — the
    /// same requirement `invoke` has.
    pub async fn read(&self, method: &str, args: Vec<ScVal>) -> Result<ScVal, ClientError> {
        let mut source_account = self.server.get_account(&self.keypair.public_key()).await?;

        let contract = Contracts::new(&self.contract_id)
            .map_err(|msg| ClientError::TransactionFailed(msg.to_string()))?;
        let operation = contract.call(method, Some(args));

        let mut builder =
            TransactionBuilder::new(&mut source_account, self.network.passphrase(), None);
        builder.add_operation(operation);
        builder.fee(BASE_FEE);
        let tx = builder.build();

        let simulation = self.server.simulate_transaction(&tx, None).await?;

        // `to_result()` returns the return value alongside the auth entries
        // the simulation recorded — reads never submit a transaction, so
        // there's nothing to attach those auth entries to; only the return
        // value matters here.
        let (result, _auth) = simulation.to_result().ok_or_else(|| {
            ClientError::TransactionFailed("simulation returned no result".into())
        })?;

        Ok(result)
    }
}
