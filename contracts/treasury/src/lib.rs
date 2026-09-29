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
//! - Events for every distribution and configuration change; topic pairs and
//!   payloads are documented in `docs/TREASURY_EVENTS.md`
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
#![no_std]

/// Semantic version of the treasury contract logic.
pub const VERSION: u32 = 1;
//! # Keeper Network Treasury (epic E08)
//!
//! Receives the protocol fees the registry's `sweep_fees` moves out of its
//! `FeesAccrued` accumulator and splits them across a configured set of
//! recipients by fixed basis-point shares. The architecture, and every
//! decision this contract implements, is pinned in `docs/TREASURY_DESIGN.md`.
//!
//! ## Flow
//!
//! 1. The registry admin calls `sweep_fees(admin, <this contract>, amount)`.
//!    That is a plain token transfer: the registry makes no call into this
//!    contract, and nothing about `sweep_fees` changed for this epic.
//! 2. Anyone calls [`Treasury::distribute`] with an amount up to
//!    [`Treasury::undistributed`]. The amount is split by [`split_amount`] and
//!    credited to each recipient's internal balance.
//! 3. Each recipient pulls its balance with [`Treasury::withdraw`].
//!
//! `distribute` only writes internal balances; it makes no outbound transfer.
//! The only external call on the distribution path is a read of this
//! contract's own token balance, so a recipient cannot re-enter it, and a
//! recipient that cannot receive tokens cannot block the others.
//!
//! ## Solvency invariant (T-1)
//!
//! `token.balance(treasury) >= TotalOwed`, where `TotalOwed` is the sum of
//! every recipient's credited, not-yet-withdrawn balance. `distribute` only
//! credits funds that are in the contract and not already owed
//! (`undistributed`), and `withdraw` reduces `TotalOwed` by exactly the amount
//! it transfers out.
//!
//! ## Storage layout
//!
//! | Key | Storage | Type |
//! |-----|---------|------|
//! | `Admin` | Instance | `Address` |
//! | `Token` | Instance | `Address` |
//! | `Recipients` | Instance | `Vec<Recipient>` (at most [`MAX_RECIPIENTS`]) |
//! | `TotalOwed` | Instance | `i128` |
//! | `TotalDistributed` | Instance | `i128` |
//! | `Balance(Address)` | Persistent | `i128` |

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Vec,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/// Contract logic version, following the registry's `VERSION` convention.
pub const VERSION: u32 = 1;

/// Every recipient set must have shares summing to exactly this total. A set
/// that does not is rejected by `set_recipients`, never normalized.
pub const TOTAL_SHARES_BPS: u32 = 10_000;

/// Upper bound on the recipient set. It bounds the loop in `distribute` and
/// keeps the whole set small enough to live in instance storage.
pub const MAX_RECIPIENTS: u32 = 10;

/// Instance TTL renewal, mirroring the registry's `INSTANCE_BUMP_*`.
const INSTANCE_BUMP_LEDGERS: u32 = 100_000;
const INSTANCE_BUMP_THRESHOLD: u32 = 50_000;

/// Recipient balance TTL renewal, mirroring the registry's
/// `KEEPER_BALANCE_BUMP_*`.
const BALANCE_BUMP_LEDGERS: u32 = 100_000;
const BALANCE_BUMP_THRESHOLD: u32 = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// One configured recipient and its share of every distribution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recipient {
    pub address: Address,
    /// Share in basis points, in `1..=TOTAL_SHARES_BPS`.
    pub shares_bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    /// The active recipient set, in configured order. Index 0 is the
    /// primary recipient, which absorbs the rounding remainder.
    Recipients,
    /// Sum of every recipient's credited, not-yet-withdrawn balance.
    TotalOwed,
    /// Lifetime sum of every successful `distribute` amount.
    TotalDistributed,
    /// A recipient's withdrawable balance.
    Balance(Address),
}

/// Discriminants are part of the published ABI. Never renumber a variant.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TreasuryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    /// The recipient set is empty, or `distribute` was called before any
    /// set was configured.
    NoRecipients = 4,
    /// More than [`MAX_RECIPIENTS`] recipients.
    TooManyRecipients = 5,
    /// A share of zero or above [`TOTAL_SHARES_BPS`].
    InvalidShare = 6,
    /// Shares do not sum to exactly [`TOTAL_SHARES_BPS`].
    SharesDoNotSumToTotal = 7,
    /// The same address appears twice in one recipient set.
    DuplicateRecipient = 8,
    /// `distribute` was given a zero or negative amount.
    InvalidAmount = 9,
    /// `distribute` asked for more than [`Treasury::undistributed`].
    InsufficientUndistributed = 10,
    /// `withdraw` found nothing credited to the caller.
    NoBalance = 11,
    ArithmeticOverflow = 12,
}

// ─────────────────────────────────────────────────────────────────────────────
// Split arithmetic
// ─────────────────────────────────────────────────────────────────────────────

/// Splits `amount` across `recipients` by their basis-point shares and
/// returns each recipient's part, in the same order.
///
/// # Rounding guarantee
///
/// Every recipient except the first gets `floor(amount * shares_bps /
/// 10_000)`. The first recipient (the primary) gets everything else:
/// `amount - sum(other parts)`. Consequences, all of which hold for every
/// input this function accepts:
///
/// - The parts sum to exactly `amount`. No value is created or lost.
/// - No recipient other than the primary ever gets more than its nominal
///   share. Each may get less, by under one stroop.
/// - The primary gets its exact nominal share plus the fractions discarded
///   from every other recipient. Those fractions total less than
///   `recipients.len() - 1` stroops, so under [`MAX_RECIPIENTS`] the primary
///   is over its nominal share by less than 9 stroops per call.
/// - Every part is non-negative.
///
/// This mirrors the registry's `split_reward`, where the keeper (the party
/// the split exists to pay) takes the floor-division remainder. Here the
/// primary recipient plays that role.
///
/// The function trusts `recipients` to be a set `set_recipients` accepted
/// (non-empty, shares summing to [`TOTAL_SHARES_BPS`]) and `amount` to be
/// non-negative; `distribute` guarantees both before calling it.
pub fn split_amount(
    e: &Env,
    amount: i128,
    recipients: &Vec<Recipient>,
) -> Result<Vec<i128>, TreasuryError> {
    let mut parts: Vec<i128> = Vec::new(e);
    let mut others: i128 = 0;
    for (i, recipient) in recipients.iter().enumerate() {
        if i == 0 {
            // Placeholder, replaced by the primary's part below.
            parts.push_back(0);
            continue;
        }
        let part = amount
            .checked_mul(recipient.shares_bps as i128)
            .ok_or(TreasuryError::ArithmeticOverflow)?
            / TOTAL_SHARES_BPS as i128; // Non-zero literal divisor, cannot fail
        others = others
            .checked_add(part)
            .ok_or(TreasuryError::ArithmeticOverflow)?;
        parts.push_back(part);
    }
    if parts.is_empty() {
        return Err(TreasuryError::NoRecipients);
    }
    let primary = amount
        .checked_sub(others)
        .ok_or(TreasuryError::ArithmeticOverflow)?;
    parts.set(0, primary);
    Ok(parts)
}

/// Validates a whole recipient set. Every rule is checked here, at
/// configuration time, so `distribute` never has to handle a bad set.
fn validate_recipients(recipients: &Vec<Recipient>) -> Result<(), TreasuryError> {
    if recipients.is_empty() {
        return Err(TreasuryError::NoRecipients);
    }
    if recipients.len() > MAX_RECIPIENTS {
        return Err(TreasuryError::TooManyRecipients);
    }
    let mut total: u32 = 0;
    for (i, recipient) in recipients.iter().enumerate() {
        if recipient.shares_bps == 0 || recipient.shares_bps > TOTAL_SHARES_BPS {
            return Err(TreasuryError::InvalidShare);
        }
        // Cannot overflow: at most MAX_RECIPIENTS shares of at most
        // TOTAL_SHARES_BPS each.
        total += recipient.shares_bps;
        // O(n^2) over at most MAX_RECIPIENTS entries.
        for earlier in recipients.iter().take(i) {
            if earlier.address == recipient.address {
                return Err(TreasuryError::DuplicateRecipient);
            }
        }
    }
    if total != TOTAL_SHARES_BPS {
        return Err(TreasuryError::SharesDoNotSumToTotal);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
}

fn require_admin(e: &Env, caller: &Address) -> Result<(), TreasuryError> {
    let admin: Address = e
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(TreasuryError::NotInitialized)?;
    caller.require_auth();
    if *caller != admin {
        return Err(TreasuryError::Unauthorized);
    }
    Ok(())
}

fn token_client(e: &Env) -> Result<token::Client<'_>, TreasuryError> {
    let addr: Address = e
        .storage()
        .instance()
        .get(&DataKey::Token)
        .ok_or(TreasuryError::NotInitialized)?;
    Ok(token::Client::new(e, &addr))
}

fn read_i128(e: &Env, key: &DataKey) -> i128 {
    e.storage().instance().get(key).unwrap_or(0)
}

fn read_balance(e: &Env, recipient: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Balance(recipient.clone()))
        .unwrap_or(0)
}

fn write_balance(e: &Env, recipient: &Address, amount: i128) {
    let key = DataKey::Balance(recipient.clone());
    e.storage().persistent().set(&key, &amount);
    e.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_BUMP_THRESHOLD, BALANCE_BUMP_LEDGERS);
}

/// Tokens held that are not owed to any recipient. Clamped at zero: the
/// balance can only fall below `TotalOwed` if the token itself takes funds
/// back (for example an issuer clawback), and then there is nothing to
/// distribute.
fn undistributed_amount(e: &Env) -> Result<i128, TreasuryError> {
    let held = token_client(e)?.balance(&e.current_contract_address());
    let owed = read_i128(e, &DataKey::TotalOwed);
    Ok(held.checked_sub(owed).unwrap_or(0).max(0))
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct Treasury;

#[contractimpl]
impl Treasury {
    /// Call once after deployment. `token` must be the same token the
    /// registry escrows rewards and accrues fees in.
    pub fn initialize(e: Env, admin: Address, token: Address) -> Result<(), TreasuryError> {
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(TreasuryError::AlreadyInitialized);
        }
        admin.require_auth();

        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Token, &token);
        e.storage().instance().set(&DataKey::TotalOwed, &0i128);
        e.storage()
            .instance()
            .set(&DataKey::TotalDistributed, &0i128);
        bump_instance(&e);

        e.events().publish(
            (symbol_short!("init"), symbol_short!("treasury")),
            (admin, token),
        );
        Ok(())
    }

    /// Replaces the whole recipient set in one call. The new set must have
    /// 1 to [`MAX_RECIPIENTS`] distinct addresses whose shares are each in
    /// `1..=TOTAL_SHARES_BPS` and sum to exactly [`TOTAL_SHARES_BPS`]. A set
    /// that breaks any rule is rejected and the previous set stays in force.
    ///
    /// Balances already credited are never touched: a recipient dropped from
    /// the set keeps its balance and can still `withdraw` it. Funds received
    /// but not yet distributed are split by whichever set is active when
    /// `distribute` runs, so an admin who wants the old split applied to
    /// them should call `distribute` before this.
    pub fn set_recipients(
        e: Env,
        admin: Address,
        recipients: Vec<Recipient>,
    ) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        validate_recipients(&recipients)?;

        bump_instance(&e);
        e.storage()
            .instance()
            .set(&DataKey::Recipients, &recipients);

        e.events()
            .publish((symbol_short!("set"), symbol_short!("recip")), recipients);
        Ok(())
    }

    /// Splits `amount` of the undistributed balance across the active
    /// recipients (see [`split_amount`] for the rounding rule) and credits
    /// each recipient's withdrawable balance.
    ///
    /// Permissionless: the split is fixed by the admin-configured set, so the
    /// caller only chooses when funds are split, never where they go. The
    /// most a caller can move by choosing `amount` is the rounding remainder,
    /// under `MAX_RECIPIENTS - 1` stroops per call, which is below the
    /// network's minimum transaction fee (docs/TREASURY_DESIGN.md §4).
    pub fn distribute(e: Env, amount: i128) -> Result<(), TreasuryError> {
        if amount <= 0 {
            return Err(TreasuryError::InvalidAmount);
        }
        let recipients: Vec<Recipient> = e
            .storage()
            .instance()
            .get(&DataKey::Recipients)
            .ok_or_else(|| {
                if e.storage().instance().has(&DataKey::Admin) {
                    TreasuryError::NoRecipients
                } else {
                    TreasuryError::NotInitialized
                }
            })?;
        if amount > undistributed_amount(&e)? {
            return Err(TreasuryError::InsufficientUndistributed);
        }

        let parts = split_amount(&e, amount, &recipients)?;

        bump_instance(&e);
        let mut breakdown: Vec<(Address, i128)> = Vec::new(&e);
        for (recipient, part) in recipients.iter().zip(parts.iter()) {
            if part > 0 {
                let updated = read_balance(&e, &recipient.address)
                    .checked_add(part)
                    .ok_or(TreasuryError::ArithmeticOverflow)?;
                write_balance(&e, &recipient.address, updated);
            }
            breakdown.push_back((recipient.address, part));
        }

        let owed = read_i128(&e, &DataKey::TotalOwed)
            .checked_add(amount)
            .ok_or(TreasuryError::ArithmeticOverflow)?;
        e.storage().instance().set(&DataKey::TotalOwed, &owed);
        let distributed = read_i128(&e, &DataKey::TotalDistributed)
            .checked_add(amount)
            .ok_or(TreasuryError::ArithmeticOverflow)?;
        e.storage()
            .instance()
            .set(&DataKey::TotalDistributed, &distributed);

        e.events().publish(
            (symbol_short!("dist"), symbol_short!("total")),
            (amount, breakdown),
        );
        Ok(())
    }

    /// A recipient pulls its whole credited balance. Checks-effects-
    /// interactions: the balance and `TotalOwed` are reduced before the token
    /// transfer, so a re-entrant call finds nothing left to withdraw.
    /// Returns the amount withdrawn.
    pub fn withdraw(e: Env, recipient: Address) -> Result<i128, TreasuryError> {
        recipient.require_auth();
        let token = token_client(&e)?;

        let balance = read_balance(&e, &recipient);
        if balance <= 0 {
            return Err(TreasuryError::NoBalance);
        }

        bump_instance(&e);
        // Effects before interaction.
        write_balance(&e, &recipient, 0);
        let owed = read_i128(&e, &DataKey::TotalOwed)
            .checked_sub(balance)
            .ok_or(TreasuryError::ArithmeticOverflow)?;
        e.storage().instance().set(&DataKey::TotalOwed, &owed);

        token.transfer(&e.current_contract_address(), &recipient, &balance);

        e.events().publish(
            (symbol_short!("wdraw"), symbol_short!("recip")),
            (recipient, balance),
        );
        Ok(balance)
    }

    /// Hands the admin role to `new_admin`. Both must authorize, so the role
    /// can never go to an address that has not agreed to take it.
    pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), TreasuryError> {
        require_admin(&e, &admin)?;
        new_admin.require_auth();
        bump_instance(&e);
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        e.events().publish(
            (symbol_short!("xfer"), symbol_short!("admin")),
            (admin, new_admin),
        );
        Ok(())
    }

    // ── Read-only views ──────────────────────────────────────────────────────
    //
    // Side-effect-free and never renew TTL, following the registry's
    // `views.rs` policy.

    /// Contract logic version. See [`VERSION`].
    pub fn version(_e: Env) -> u32 {
        VERSION
    }

    /// The active recipient set, in configured order. Empty if none has been
    /// configured yet.
    pub fn recipients(e: Env) -> Vec<Recipient> {
        e.storage()
            .instance()
            .get(&DataKey::Recipients)
            .unwrap_or_else(|| Vec::new(&e))
    }

    /// A recipient's credited, withdrawable balance (0 if none).
    pub fn recipient_balance(e: Env, recipient: Address) -> i128 {
        read_balance(&e, &recipient)
    }

    /// Tokens held by this contract that are not yet credited to any
    /// recipient: the most `distribute` will currently accept.
    pub fn undistributed(e: Env) -> Result<i128, TreasuryError> {
        undistributed_amount(&e)
    }

    /// Lifetime sum of every successful `distribute` amount. Reconciles
    /// against the `("dist", "total")` event stream.
    pub fn total_distributed(e: Env) -> i128 {
        read_i128(&e, &DataKey::TotalDistributed)
    }
}

#[cfg(test)]
mod test;
