//! # Soroban Keeper Network — Keeper Registry Contract
//!
//! This is the on-chain coordination layer of the Soroban Keeper Network.
//! dApps register automation tasks (liquidations, oracle pushes, TTL extensions…)
//! with an XLM reward bounty. Permissionless keeper bots compete to execute them.
//!
//! ## Implemented surface (MVP complete)
//! - Full schema: storage keys, types, errors, and events
//! - `initialize` / `register_task` — deploy, configure, and post funded tasks
//! - `batch_register_tasks` — register up to [`MAX_BATCH_SIZE`] tasks under a
//!   single owner auth, with a `max_total_reward` ceiling on the escrow the
//!   call may pull (see `docs/BATCH_OPERATIONS.md`)
//! - `claim_task` — first-come-first-served keeper locking with re-claim after
//!   the lock window elapses
//! - `execute_task` — proof submission, reward split, keeper crediting
//! - `cancel_task` / `expire_task` — owner refund and permissionless expiry
//! - `withdraw_rewards` — keeper pulls its accrued balance (CEI-safe)
//! - Admin: `pause`/`unpause`, `set_fee_bps`, `transfer_admin`, `upgrade`,
//!   `sweep_fees`
//! - Read-only views — `get_task`, `task_count`, `keeper_balance`,
//!   `fees_accrued`, `is_paused`, etc.
//!
//! ## Where contributors come in
//! The MVP is functional; the next 100 issues (0051–0150) are now published
//! across three epics: **E03 Fuzzing & Invariant Testing**, **E04 On-chain
//! Execution Verifier**, and **E05 Batch Operations & Gas**. See the epic
//! index in `.github/backlog/README.md` for the complete roadmap, or
//! `CONTRIBUTING.md` for branching rules and the PR checklist.
//!
//! ## Verifier Execution & Resource Costs (Phase 2 / E04)
//! In Phase 2, tasks may optionally attach an on-chain verifier contract
//! (`IKeeperVerifier`). In Soroban, sub-contract calls run synchronously
//! against the caller's transaction budget, with no in-band mechanism to cap
//! sub-call resource consumption. The executing keeper bears the entire
//! transaction gas/resource cost of the attached verifier. Keepers and keeper
//! bots must inspect and simulate verifier calls (`verify`) prior to claiming
//! to ensure net profitability. See `docs/VERIFIER_DESIGN.md` §3.
//!
//! ## Storage Layout
//! - Instance:   Admin, FeeBps, Paused, TaskCounter, RewardToken, FeesAccrued
//! - Persistent: Task(id) → Task struct, KeeperReward(address) → i128

#![no_std]

use soroban_sdk::contract;

mod admin;
mod batch;
mod constants;
mod errors;
mod events;
mod internal;
mod task;
mod types;
mod verifier;
mod views;

pub use constants::*;
pub use errors::KeeperError;
pub use events::*;
pub use types::{BatchTaskParams, DataKey, Task, TaskStatus, TaskType};
pub use verifier::{IKeeperVerifier, KeeperVerifierClient};

// Re-exported for the test and fuzz harnesses, which assert on the reward
// split directly rather than inferring it from a balance delta.
pub use internal::split_reward;

#[contract]
pub struct KeeperRegistry;

#[cfg(any(test, fuzzing))]
pub mod invariants;

// Shared reentrant-token mock for the CEI regression tests (`test/cancel.rs`,
// `test/expire.rs`) and the `reentrancy` fuzz target — see its module doc.
#[cfg(any(test, fuzzing))]
pub mod mocks;

#[cfg(test)]
mod test;
