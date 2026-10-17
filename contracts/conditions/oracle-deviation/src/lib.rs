#![no_std]

//! Immutable Reflector-backed price-deviation condition.

use keeper_oracle_client::{read_normalized, Asset};
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, U256};

const MIN_MAX_AGE_SECONDS: u64 = 1;
const MAX_MAX_AGE_SECONDS: u64 = 86_400;
const BPS_SCALE: u32 = 10_000;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviationConfig {
    pub oracle: Address,
    pub asset: Asset,
    pub max_age_seconds: u64,
    pub basis_points: u32,
    pub reference_price: u128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DeviationError {
    AlreadyInitialized = 1,
    InvalidBasisPoints = 2,
    InvalidMaxAge = 3,
    PriceUnavailable = 4,
    NotInitialized = 5,
}

#[contract]
pub struct OracleDeviationCondition;

#[contractimpl]
impl OracleDeviationCondition {
    /// Captures the reference price exactly once. There is deliberately no
    /// setter for the stored configuration or reference value.
    pub fn initialize(
        env: Env,
        oracle: Address,
        asset: Asset,
        max_age_seconds: u64,
        basis_points: u32,
    ) -> Result<(), DeviationError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(DeviationError::AlreadyInitialized);
        }
        if basis_points > BPS_SCALE {
            return Err(DeviationError::InvalidBasisPoints);
        }
        if !(MIN_MAX_AGE_SECONDS..=MAX_MAX_AGE_SECONDS).contains(&max_age_seconds) {
            return Err(DeviationError::InvalidMaxAge);
        }

        let reference = read_normalized(&env, &oracle, &asset, max_age_seconds)
            .ok_or(DeviationError::PriceUnavailable)?;
        env.storage().instance().set(
            &DataKey::Config,
            &DeviationConfig {
                oracle,
                asset,
                max_age_seconds,
                basis_points,
                reference_price: reference.value,
            },
        );
        Ok(())
    }

    /// Implements the registry's generic task-condition interface.
    pub fn is_met(env: Env, _task_id: u64) -> bool {
        let Some(config): Option<DeviationConfig> = env.storage().instance().get(&DataKey::Config)
        else {
            return false;
        };
        let Some(current) =
            read_normalized(&env, &config.oracle, &config.asset, config.max_age_seconds)
        else {
            return false;
        };

        deviation_met(
            &env,
            config.reference_price,
            current.value,
            config.basis_points,
        )
    }

    pub fn config(env: Env) -> Result<DeviationConfig, DeviationError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(DeviationError::NotInitialized)
    }
}

fn deviation_met(env: &Env, reference: u128, current: u128, basis_points: u32) -> bool {
    let difference = if current >= reference {
        current.checked_sub(reference)
    } else {
        reference.checked_sub(current)
    };
    let Some(difference) = difference else {
        return false;
    };

    // A u128 multiplied by at most 10_000 fits in U256. Keeping both sides in
    // U256 makes the multiplication exact and avoids division/rounding.
    let moved = U256::from_u128(env, difference).mul(&U256::from_u32(env, BPS_SCALE));
    let required = U256::from_u128(env, reference).mul(&U256::from_u32(env, basis_points));
    moved >= required
}

#[cfg(test)]
mod test;
