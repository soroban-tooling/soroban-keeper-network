//! Rust client SDK for the Soroban Keeper Network contract.
//!
//! Provides typed client wrappers, event decoders, batch operations, pluggable signing,
//! network configurations, retry policies, and cross-contract call builders.

pub mod client;
pub mod cross_contract;
pub mod events;
pub mod network;
pub mod retry;
pub mod signing;
pub mod types;

pub use client::{ClientError, KeeperClient};
pub use cross_contract::{CrossContractInvocation, KeeperRegistryCrossContract};
pub use events::{
    EventDecodeError, FeesSweptEvent, InitializedEvent, KeeperEvent, PausedEvent,
    RewardsWithdrawnEvent, TaskCancelledEvent, TaskClaimedEvent, TaskExecutedEvent,
    TaskExpiredEvent, TaskRegisteredEvent,
};
pub use network::{CustomNetworkConfig, Network, NetworkConfig, FUTURENET, MAINNET, TESTNET};
pub use retry::{default_classify, ErrorClass, RetryPolicy, RpcCallError, TransportError};
pub use signing::{KeypairSigner, SignerError, TransactionSigner};
pub use types::{BatchTaskParams, Task, TaskStatus, TaskType};
