#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ConditionTemplateError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    InvalidConfiguration = 3,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    TaskThreshold(u64),
    TaskCurrentValue(u64),
}

/// The official ITaskCondition interface required by Soroban Keeper Network (Epic E10).
/// See docs/TASK_CONDITIONS_DESIGN.md.
#[contractclient(name = "TaskConditionClient")]
pub trait ITaskCondition {
    /// Returns `true` if the condition that triggered the need for `task_id`
    /// is currently satisfied, `false` otherwise.
    ///
    /// Must never panic on a merely-false condition — return `false`.
    fn is_met(env: Env, task_id: u64) -> bool;
}

#[contract]
pub struct ConditionTemplateContract;

#[contractimpl]
impl ConditionTemplateContract {
    /// Initializes the condition template contract with an owner.
    pub fn initialize(env: Env, owner: Address) -> Result<(), ConditionTemplateError> {
        if env.storage().instance().has(&DataKey::Owner) {
            return Err(ConditionTemplateError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().extend_ttl(50_000, 100_000);
        Ok(())
    }

    /// Sets the trigger threshold for a specific task ID.
    pub fn set_task_threshold(env: Env, task_id: u64, threshold: i128) {
        if let Some(owner) = env.storage().instance().get::<_, Address>(&DataKey::Owner) {
            owner.require_auth();
        }
        env.storage()
            .persistent()
            .set(&DataKey::TaskThreshold(task_id), &threshold);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::TaskThreshold(task_id), 50_000, 100_000);
    }

    /// Updates the observed state/value for a task (e.g. simulated price or metric).
    pub fn update_metric_value(env: Env, task_id: u64, value: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::TaskCurrentValue(task_id), &value);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::TaskCurrentValue(task_id), 50_000, 100_000);
    }

    /// Implements `ITaskCondition::is_met(env, task_id) -> bool`.
    /// Called by the Keeper Registry during `claim_task`.
    ///
    /// Returns `true` if current_value >= threshold.
    /// Returns `false` if unconfigured or threshold not reached. Never panics.
    pub fn is_met(env: Env, task_id: u64) -> bool {
        let threshold = match env
            .storage()
            .persistent()
            .get::<_, i128>(&DataKey::TaskThreshold(task_id))
        {
            Some(t) => t,
            None => return false,
        };

        let current_value = env
            .storage()
            .persistent()
            .get::<_, i128>(&DataKey::TaskCurrentValue(task_id))
            .unwrap_or(0);

        current_value >= threshold
    }
}

#[cfg(test)]
mod test;
