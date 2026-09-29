//! Keeper reputation bookkeeping.
//!
//! Reputation is the keeper's successful-task rate in basis points:
//! `successes * 10_000 / (successes + missed_claims)`. An address with no
//! tracked actions has a zero record. Counts are retained rather than
//! overwritten so callers can judge the confidence behind the rate. The
//! effective score is lazily halved once per 100,000 ledgers without changing
//! stored history.


//!
//! The admin may set an eligibility floor that `claim_task` checks against the
//! claiming keeper's stored score; it defaults to 0, which disables it.

use soroban_sdk::{contractimpl, contracttype, Address, Env};

use crate::errors::KeeperError::types::DataKey;
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

/// One score half-life, in ledgers. Decay is a deterministic right shift by
/// the number of complete half-life intervals since the last tracked action.
pub const REPUTATION_DECAY_HALF_LIFE_LEDGERS: u32 = 100_000;
const REPUTATION_TTL_THRESHOLD: u32 = 50_000;
const REPUTATION_TTL_LEDGERS: u32 = 6_300_000;

/// Stored history for one keeper. `score_bps` is the rate at the time of the
/// last action. The stored rate does not decay between actions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationRecord {
    pub successes: u64,
    pub missed_claims: u64,
    pub score_bps: u32,
    pub last_updated_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum ReputationKey {
    Keeper(Address),
}

impl ReputationRecord {
    pub fn zero() -> Self {
        Self {
            successes: 0,
            missed_claims: 0,
            score_bps: 0,
            last_updated_ledger: 0,
        }
    }

    fn recompute(&mut self) {
        let actions = self.successes.saturating_add(self.missed_claims);
        self.score_bps = if actions == 0 {
            0
        } else {
            ((self.successes as u128 * 10_000) / actions as u128) as u32
        };
    }
}

fn update(e: &Env, keeper: &Address, success: bool) {
    let key = ReputationKey::Keeper(keeper.clone());
    let mut record: ReputationRecord = e
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(ReputationRecord::zero);
    if success {
        record.successes = record.successes.saturating_add(1);
    } else {
        record.missed_claims = record.missed_claims.saturating_add(1);
    }
    record.last_updated_ledger = e.ledger().sequence();
    record.recompute();
    e.storage().persistent().set(&key, &record);
    e.storage()
        .persistent()
        .extend_ttl(&key, REPUTATION_TTL_THRESHOLD, REPUTATION_TTL_LEDGERS);
}

pub(crate) fn record_success(e: &Env, keeper: &Address) {
    update(e, keeper, true);
}

pub(crate) fn record_missed_claim(e: &Env, keeper: &Address) {
    update(e, keeper, false);
}

pub(crate) fn stored_record(e: &Env, keeper: &Address) -> ReputationRecord {
    e.storage()
        .persistent()
        .get(&ReputationKey::Keeper(keeper.clone()))
        .unwrap_or_else(ReputationRecord::zero)
}

pub(crate) fn reputation_floor_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::ReputationFloor)
        .unwrap_or(0)
}

/// Rejects `keeper` if its stored score is below the configured floor.
///
/// The stored score is used, not the decayed one: decay only ever lowers a
/// score, and a keeper can only raise it by claiming, so gating on the decayed
/// score would permanently lock out a reliable keeper that merely went idle
/// for a few half-lives. A keeper with no tracked history scores 0, so any
/// non-zero floor also excludes new addresses; exempting them instead would
/// let a low-score keeper evade the floor by claiming from a fresh address.
pub(crate) fn require_reputation_floor(e: &Env, keeper: &Address) -> Result<(), KeeperError> {
    let floor = reputation_floor_bps(e);
    // Disabled floor: skip the per-keeper read entirely.
    if floor == 0 {
        return Ok(());
    }
    if stored_record(e, keeper).score_bps < floor {
        return Err(KeeperError::ReputationBelowFloor);
    }
    Ok(())
}

/// Computes the read-time reputation. At elapsed ledger `n * half_life`, the
/// score is `floor(score_bps / 2^n)`; between those boundaries it is unchanged.
/// A shift of 32 or more yields zero, matching integer floor division.
pub fn effective_record(mut record: ReputationRecord, current_ledger: u32) -> ReputationRecord {
    let elapsed = current_ledger.saturating_sub(record.last_updated_ledger);
    let halvings = elapsed / REPUTATION_DECAY_HALF_LIFE_LEDGERS;
    record.score_bps = if halvings >= u32::BITS {
        0
    } else {
        record.score_bps >> halvings
    };
    record
}

#[contractimpl]
impl KeeperRegistry {
    /// Read-only: returns the stored reputation record, or a zero record if
    /// this keeper has no tracked actions. This view never renews storage TTL.
    pub fn keeper_reputation(e: Env, keeper: Address) -> ReputationRecord {
        stored_record(&e, &keeper)
    }

    /// Read-only: returns the stored reputation with its score lazily decayed
    /// to the current ledger. No storage value or TTL is changed.
    pub fn effective_reputation(e: Env, keeper: Address) -> ReputationRecord {
        effective_record(stored_record(&e, &keeper), e.ledger().sequence())
    }
}
