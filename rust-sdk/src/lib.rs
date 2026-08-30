//! Soroban Keeper Network Rust SDK.
//!
//! Provides typed client wrappers, event decoders, batch operations, and pluggable signing.

#![no_std]
extern crate alloc;

pub mod client;
pub mod events;
pub mod signing;
pub mod types;

pub use client::{ClientError, KeeperClient};
pub use events::{
    EventDecodeError, FeesSweptEvent, InitializedEvent, KeeperEvent, PausedEvent,
    RewardsWithdrawnEvent, TaskCancelledEvent, TaskClaimedEvent, TaskExecutedEvent,
    TaskExpiredEvent, TaskRegisteredEvent,
};
pub use signing::{KeypairSigner, SignerError, TransactionSigner};
pub use types::{BatchTaskParams, Task, TaskStatus, TaskType};
