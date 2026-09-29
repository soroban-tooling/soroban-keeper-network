//! Storage keys and the domain types they hold.

use soroban_sdk::{contracttype, Address};

// ─────────────────────────────────────────────────────────────────────────────
// Storage Keys
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    RewardToken,
    /// Ordered list of currently-registered recipient addresses. Kept as a
    /// single Vec (bounded by [`crate::constants::MAX_RECIPIENTS`]) so
    /// `distribute` can iterate every recipient in one read rather than
    /// needing a separate index structure.
    RecipientList,
    /// A recipient's relative weight, in basis points. Shares are not
    /// required to sum to 10_000 across all recipients — `distribute` splits
    /// pro-rata against the sum of shares actually registered at the time of
    /// the call, so adding or removing a recipient never leaves a dangling
    /// remainder unaccounted for.
    RecipientShares(Address),
    /// A recipient's withdrawable balance, credited by `distribute` and
    /// zeroed by `withdraw`.
    RecipientBalance(Address),
    /// Lifetime total ever credited to this recipient. Unlike
    /// `RecipientBalance`, this never decreases — it is the "total ever
    /// received" figure the read-only views expose.
    RecipientReceivedTotal(Address),
    /// Lifetime total ever distributed to any recipient. The single source of
    /// truth an indexer's independently-summed `Distributed` events must
    /// agree with once it is caught up.
    TotalDistributed,
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/// A recipient's current configuration, as returned by [`crate::Treasury::recipients`].
#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Recipient {
    pub address: Address,
    pub shares_bps: u32,
}
