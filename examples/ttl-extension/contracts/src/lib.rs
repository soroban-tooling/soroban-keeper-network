#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TtlError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidTtlParams = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Record,
    ExtendedCount,
}

#[contract]
pub struct TtlExtensionContract;

#[contractimpl]
impl TtlExtensionContract {
    /// Initialize the contract with an admin and an initial persistent record.
    pub fn init(env: Env, admin: Address, initial_value: u64) -> Result<(), TtlError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(TtlError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Record, &initial_value);
        env.storage().instance().set(&DataKey::ExtendedCount, &0u32);

        // Initial TTL extension for safety (e.g. 1000 ledgers threshold, bump to 10000 ledgers)
        env.storage().instance().extend_ttl(1000, 10000);
        env.storage().persistent().extend_ttl(&DataKey::Record, 1000, 10000);

        Ok(())
    }

    /// Keeper entry point: extends the Time-To-Live (TTL) of the contract's instance
    /// and persistent storage entries when they fall below `threshold` ledgers.
    ///
    /// This function is permissionless so that any authorized keeper from the
    /// Soroban Keeper Network can execute it upon task triggering.
    pub fn extend_ttl(env: Env, threshold: u32, extend_to: u32) -> Result<u32, TtlError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(TtlError::NotInitialized);
        }

        if threshold >= extend_to {
            return Err(TtlError::InvalidTtlParams);
        }

        // Extend instance storage
        env.storage().instance().extend_ttl(threshold, extend_to);

        // Extend critical persistent state entries
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Record, threshold, extend_to);

        // Track how many times keepers have extended this contract's storage
        let mut count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ExtendedCount)
            .unwrap_or(0);
        count = count.saturating_add(1);
        env.storage().instance().set(&DataKey::ExtendedCount, &count);

        env.events().publish(
            (symbol_short!("ttl_ext"),),
            (threshold, extend_to, count),
        );

        Ok(count)
    }

    /// Read the persistent record, confirming that storage is alive and accessible.
    pub fn get_record(env: Env) -> Result<u64, TtlError> {
        env.storage()
            .persistent()
            .get(&DataKey::Record)
            .ok_or(TtlError::NotInitialized)
    }

    /// Update the persistent record (requires admin auth).
    pub fn set_record(env: Env, admin: Address, new_value: u64) -> Result<(), TtlError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TtlError::NotInitialized)?;

        if admin != stored_admin {
            return Err(TtlError::Unauthorized);
        }

        env.storage().persistent().set(&DataKey::Record, &new_value);
        Ok(())
    }

    /// Get the total number of keeper-triggered extensions performed.
    pub fn get_extension_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ExtendedCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
