//! # Soroban Keeper Network — Treasury Contract
//!
//! A standalone contract that receives funds and distributes them to a
//! configurable set of recipients, pro-rata by share. It follows the same
//! module layout, admin/pause/upgrade conventions, and CEI discipline as
//! `contracts/keeper-registry`.
//!
//! ## Implemented surface
//! - `initialize` — deploy and configure with an admin and a reward token
//! - `add_recipient` / `remove_recipient` / `update_recipient_shares` —
//!   admin-only recipient configuration
//! - `distribute` — permissionless: pulls funds from the caller and credits
//!   every registered recipient pro-rata by share
//! - `withdraw` — a recipient pulls its accrued, withdrawable balance
//! - Admin: `pause`/`unpause`, `transfer_admin`, `upgrade`
//! - Read-only views — `recipients`, `recipient_shares`, `recipient_balance`,
//!   `recipient_total_received`, `total_distributed`, `is_paused`, etc.
//!
//! ## Storage Layout
//! - Instance:   Admin, Paused, RewardToken, RecipientList, TotalDistributed
//! - Persistent: RecipientShares(addr), RecipientBalance(addr),
//!   RecipientReceivedTotal(addr)

#![no_std]

use soroban_sdk::contract;

mod admin;
mod constants;
mod distribution;
mod errors;
mod events;
mod internal;
mod mocks;
mod types;
mod views;

pub use constants::*;
pub use errors::TreasuryError;
pub use events::*;
pub use types::{DataKey, Recipient};

#[contract]
pub struct Treasury;

#[cfg(test)]
mod test;
