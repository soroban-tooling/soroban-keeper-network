//! Rust client SDK for the Soroban Keeper Network contract.
//!
//! Provides typed client wrappers, event decoders, batch operations, pluggable signing,
//! network configurations, retry policies, and cross-contract call builders.

use core::ops::RangeInclusive;

/// Contract `VERSION` values this SDK was built and tested against.
pub const SUPPORTED_CONTRACT_VERSIONS: RangeInclusive<u32> = 1..=6;

pub mod client;
pub mod cross_contract;
pub mod error;
pub mod events;
pub mod network;
pub mod retry;
pub mod signing;
pub mod treasury_client;
pub mod types;

pub use client::{
    ClientError, InvocationRequest, KeeperClient, KeeperRegistryClient, RegistryClientError,
    RpcTransport, SignedTransaction, SimulationOutcome,
};
pub use cross_contract::{CrossContractInvocation, KeeperRegistryCrossContract};
pub use error::{CallContext, Redacted};
pub use events::{
    EventDecodeError, FeesSweptEvent, InitializedEvent, KeeperEvent, PausedEvent,
    RewardsWithdrawnEvent, TaskCancelledEvent, TaskClaimedEvent, TaskExecutedEvent,
    TaskExpiredEvent, TaskRegisteredEvent,
};
pub use network::{CustomNetworkConfig, Network, NetworkConfig, FUTURENET, MAINNET, TESTNET};
pub use retry::{default_classify, ErrorClass, RetryPolicy, RpcCallError, TransportError};
pub use signing::{KeypairSigner, SignerError, TransactionSigner};
pub use treasury_client::{Recipient, TreasuryClient};
pub use types::{
    BatchTaskParams, PendingCredit, SlashRecord, Task, TaskStatus, TaskType, UnbondRequest,
};
