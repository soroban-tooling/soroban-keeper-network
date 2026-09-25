//! The contract's error enum.
//!
//! Discriminants are part of the published ABI: off-chain clients decode them
//! by number. Never renumber an existing variant, and allocate the next free
//! number when adding one.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TreasuryError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    ContractPaused = 3,
    /// A function requiring configured state (`initialize` must have been
    /// called) was invoked on a treasury that isn't configured yet.
    NotInitialized = 4,
    RecipientNotFound = 5,
    RecipientAlreadyExists = 6,
    /// `shares_bps` was zero or exceeded [`crate::constants::MAX_SHARES_BPS`].
    InvalidShares = 7,
    /// `distribute` was called with no recipients registered.
    NoRecipients = 8,
    /// An amount passed to `distribute` was not strictly positive.
    InvalidAmount = 9,
    /// `withdraw` was called against a zero balance.
    NoRewardsAvailable = 10,
    /// Arithmetic operation would overflow or underflow.
    ArithmeticOverflow = 11,
    /// Adding a recipient would exceed [`crate::constants::MAX_RECIPIENTS`].
    TooManyRecipients = 12,
}
