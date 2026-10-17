use soroban_sdk::{contract, contractimpl, contracttype, Env};

use crate::{Asset, PriceData};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Decimals,
    Price(Asset),
}

#[contract]
pub struct MockReflector;

#[contractimpl]
impl MockReflector {
    pub fn set_decimals(env: Env, decimals: u32) {
        env.storage().instance().set(&DataKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&DataKey::Price(asset), &PriceData { price, timestamp });
    }

    pub fn clear_price(env: Env, asset: Asset) {
        env.storage().instance().remove(&DataKey::Price(asset));
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(7)
    }

    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        env.storage().instance().get(&DataKey::Price(asset))
    }
}
