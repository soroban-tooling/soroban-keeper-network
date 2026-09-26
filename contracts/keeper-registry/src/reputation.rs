//! Keeper reputation bookkeeping.
//!
//! Reputation is the keeper's successful-task rate in basis points:
//! `successes * 10_000 / (successes + missed_claims)`. An address with no
//! tracked actions has a zero record. Counts are retained rather than
//! overwritten so callers can judge the confidence behind the rate.

use soroban_sdk::{contracttype, Address, Env};

use crate::constants::{KEEPER_BALANCE_BUMP_LEDGERS, KEEPER_BALANCE_BUMP_THRESHOLD};

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
    e.storage().persistent().extend_ttl(
        &key,
        KEEPER_BALANCE_BUMP_THRESHOLD,
        KEEPER_BALANCE_BUMP_LEDGERS,
    );
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
