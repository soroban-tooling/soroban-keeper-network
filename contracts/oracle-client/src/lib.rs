#![no_std]

//! Typed, `no_std` access to the Reflector Pulse SEP-40 price interface.
//!
//! The ABI mirrors Reflector's published contract interface:
//! <https://github.com/reflector-network/reflector-contract>.

use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "ReflectorPulseClient")]
pub trait ReflectorPulse {
    fn decimals() -> u32;
    fn lastprice(asset: Asset) -> Option<PriceData>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedPrice {
    pub value: u128,
    pub observed_at: u64,
}

/// Reads a fresh positive price and normalizes it to exactly 18 decimals.
/// Any provider, conversion, timestamp, or arithmetic failure returns `None`.
pub fn read_normalized(
    env: &Env,
    oracle: &Address,
    asset: &Asset,
    max_age_seconds: u64,
) -> Option<NormalizedPrice> {
    let client = ReflectorPulseClient::new(env, oracle);
    let decimals = match client.try_decimals() {
        Ok(Ok(value)) if value <= 18 => value,
        _ => return None,
    };
    let data = match client.try_lastprice(asset) {
        Ok(Ok(Some(value))) => value,
        _ => return None,
    };
    if data.price <= 0 {
        return None;
    }

    let now = env.ledger().timestamp();
    if data.timestamp > now || now.checked_sub(data.timestamp)? > max_age_seconds {
        return None;
    }

    let multiplier = 10_u128.checked_pow(18_u32.checked_sub(decimals)?)?;
    let value = (data.price as u128).checked_mul(multiplier)?;
    Some(NormalizedPrice {
        value,
        observed_at: data.timestamp,
    })
}

#[cfg(feature = "testutils")]
pub mod mock;
