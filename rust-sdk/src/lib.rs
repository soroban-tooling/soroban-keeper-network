//! Rust client SDK for the Soroban Keeper Network contracts.
//!
//! Provides typed client wrappers, event decoders, batch operations, pluggable signing,
//! network configurations, retry policies, and cross-contract call builders.
//!
//! # Feature flags
//!
//! This release has no optional feature flags. The default feature set is
//! intentionally empty, so every documented API is available in all builds.
//!
//! # Example
//!
//! Network presets and retry configuration can be prepared without choosing
//! an async runtime or RPC implementation:
//!
//! ```
//! use soroban_keeper_sdk::{Network, RetryPolicy};
//!
//! let network = Network::Testnet;
//! let retry = RetryPolicy::no_retry();
//!
//! assert!(network.rpc_url().starts_with("https://"));
//! assert_eq!(retry.max_attempts, 1);
//! ```

pub mod client;
pub mod cross_contract;
pub mod error;
pub mod events;
pub mod network;
pub mod retry;
pub mod signing;
pub mod stream;
pub mod treasury_client;
pub mod types;

pub use client::{
    ClientError, InvocationRequest, KeeperClient, KeeperRegistryClient, RegistryClientError,
    RpcTransport, SignedTransaction, SimulationOutcome,
};
pub use cross_contract::{CrossContractInvocation, KeeperRegistryCrossContract};
pub use error::{CallContext, Redacted};
pub use events::{
    decode_event, EventDecodeError, FeesSweptEvent, InitializedEvent, KeeperEvent, PausedEvent,
    RewardsWithdrawnEvent, TaskCancelledEvent, TaskClaimedEvent, TaskExecutedEvent,
    TaskExpiredEvent, TaskRegisteredEvent,
};
pub use network::{CustomNetworkConfig, Network, NetworkConfig, FUTURENET, MAINNET, TESTNET};
pub use retry::{default_classify, ErrorClass, RetryPolicy, RpcCallError, TransportError};
pub use signing::{KeypairSigner, SignerError, TransactionSigner};
pub use stream::{
    EventPage, EventPageRequest, EventStart, EventStreamError, EventTransport, RawContractEvent,
    RegistryEventStream, StreamEvent,
};
pub use treasury_client::{Recipient, TreasuryClient};
pub use types::{
    BatchTaskParams, PendingCredit, SlashRecord, Task, TaskStatus, TaskType, UnbondRequest,
};
