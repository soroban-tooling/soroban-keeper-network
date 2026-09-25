//! Tunable bounds and protocol constants.
//!
//! Every magic number the contract enforces lives here so a change is a
//! one-line edit rather than a hunt through the call sites. Mirrors
//! `contracts/keeper-registry/src/constants.rs`.

/// Maximum number of recipients `distribute` will ever iterate in one call.
/// Each recipient costs one persistent-storage read and write, so this bounds
/// the resource cost of a single distribution the same way
/// `keeper-registry::MAX_BATCH_SIZE` bounds a batch registration.
pub const MAX_RECIPIENTS: u32 = 50;

/// Basis-point denominator. A recipient's `shares_bps` must be in `1..=MAX_SHARES_BPS`.
pub const MAX_SHARES_BPS: u32 = 10_000;

/// Ledgers of instance-storage lifetime requested on each state-mutating
/// call. Mirrors `keeper-registry::INSTANCE_BUMP_LEDGERS`.
pub(crate) const INSTANCE_BUMP_LEDGERS: u32 = 100_000;
/// Renew instance TTL only once fewer than this many ledgers remain. Mirrors
/// `keeper-registry::INSTANCE_BUMP_THRESHOLD`.
pub(crate) const INSTANCE_BUMP_THRESHOLD: u32 = 50_000;

/// Ledgers of persistent-storage lifetime requested for a recipient's balance
/// entry each time it is credited. Mirrors `keeper-registry::KEEPER_BALANCE_BUMP_LEDGERS`.
pub(crate) const RECIPIENT_BALANCE_BUMP_LEDGERS: u32 = 100_000;
/// Renew a recipient balance entry only once fewer than this many ledgers
/// remain. Mirrors `keeper-registry::KEEPER_BALANCE_BUMP_THRESHOLD`.
pub(crate) const RECIPIENT_BALANCE_BUMP_THRESHOLD: u32 = 50_000;

/// Semantic version of the contract logic. Bumped on behavior changes so
/// off-chain clients and indexers can detect which ABI they are talking to.
pub const VERSION: u32 = 1;
