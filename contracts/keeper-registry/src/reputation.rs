//! Keeper reputation storage, tracking, and TTL renewal.
//!
//! Tracks on-chain operational reliability of keepers via persistent-storage records.
//! In accordance with issue 0332 / #460, every write to a keeper's reputation record
//! MUST renew its persistent storage TTL so it cannot silently archive while active.

use soroban_sdk::{contractimpl, contracttype, Address, Env};

use crate::constants::{KEEPER_BALANCE_BUMP_LEDGERS, KEEPER_BALANCE_BUMP_THRESHOLD};
use crate::internal::bump_instance;
use crate::types::DataKey;
use crate::{KeeperRegistry, KeeperRegistryArgs, KeeperRegistryClient};

/// Persistent storage TTL bump parameters for keeper reputation records,
/// mirroring [`KEEPER_BALANCE_BUMP_LEDGERS`] and [`KEEPER_BALANCE_BUMP_THRESHOLD`].
pub const REPUTATION_BUMP_LEDGERS: u32 = KEEPER_BALANCE_BUMP_LEDGERS;
pub const REPUTATION_BUMP_THRESHOLD: u32 = KEEPER_BALANCE_BUMP_THRESHOLD;

/// On-chain reputation record tracking a keeper's operational reliability.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperReputationRecord {
    pub successful_executions: u32,
    pub missed_locks: u32,
    pub last_update_ledger: u32,
    pub base_score: u32,
    pub effective_score: u32,
}

impl Default for KeeperReputationRecord {
    fn default() -> Self {
        Self {
            successful_executions: 0,
            missed_locks: 0,
            last_update_ledger: 0,
            base_score: 0,
            effective_score: 0,
        }
    }
}

/// Loads a keeper's reputation record from persistent storage.
/// Returns a zero-initialized default if untracked. Side-effect-free, simulation-safe,
/// and never bumps storage TTL.
pub fn load_reputation(e: &Env, keeper: &Address) -> KeeperReputationRecord {
    e.storage()
        .persistent()
        .get(&DataKey::KeeperReputation(keeper.clone()))
        .unwrap_or(KeeperReputationRecord {
            successful_executions: 0,
            missed_locks: 0,
            last_update_ledger: e.ledger().sequence(),
            base_score: 0,
            effective_score: 0,
        })
}

/// Saves a keeper's reputation record to persistent storage and renews its TTL.
///
/// Every write to a keeper's reputation record MUST extend both instance TTL
/// (via [`bump_instance`]) and its persistent entry TTL so it cannot silently
/// archive while the keeper remains active.
pub fn save_reputation(e: &Env, keeper: &Address, record: &KeeperReputationRecord) {
    bump_instance(e);
    let key = DataKey::KeeperReputation(keeper.clone());
    e.storage().persistent().set(&key, record);
    e.storage()
        .persistent()
        .extend_ttl(&key, REPUTATION_BUMP_THRESHOLD, REPUTATION_BUMP_LEDGERS);
}

/// Records a successful task execution, incrementing score and renewing TTL.
pub fn record_success(e: &Env, keeper: &Address) -> KeeperReputationRecord {
    let mut record = load_reputation(e, keeper);
    record.successful_executions = record.successful_executions.saturating_add(1);
    record.base_score = record.base_score.saturating_add(1);
    record.last_update_ledger = e.ledger().sequence();
    record.effective_score = record.base_score;
    save_reputation(e, keeper, &record);
    record
}

/// Records a missed lock window, decrementing score and renewing TTL.
pub fn record_missed_lock(e: &Env, keeper: &Address) -> KeeperReputationRecord {
    let mut record = load_reputation(e, keeper);
    record.missed_locks = record.missed_locks.saturating_add(1);
    record.base_score = record.base_score.saturating_sub(1);
    record.last_update_ledger = e.ledger().sequence();
    record.effective_score = record.base_score;
    save_reputation(e, keeper, &record);
    record
}

#[contractimpl]
impl KeeperRegistry {
    /// Read-only view returning the reputation record for `keeper`.
    /// Simulation-safe, side-effect-free, does not bump TTL.
    pub fn keeper_reputation(e: Env, keeper: Address) -> KeeperReputationRecord {
        load_reputation(&e, &keeper)
    }
}
