#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized = 1,
    NegativeAmount = 2,
    InsufficientBalance = 3,
    InsufficientAllowance = 4,
    TokensLocked = 5,
    InvalidExpiration = 6,
    Unauthorized = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_duration: u64,
    pub total_duration: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceDataKey {
    pub from: Address,
    pub spender: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Checkpoint {
    pub ledger: u32,
    pub balance: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    Balance(Address),
    Allowance(AllowanceDataKey),
    Vesting(Address),
    CheckpointCount(Address),
    Checkpoint(Address, u32),
}

pub const DECIMALS: u32 = 7;
pub const ONE_TOKEN: i128 = 10_000_000; // 10^7 stroops / base units

// Supply allocations per Issue #488 & #489
pub const TOTAL_SUPPLY: i128 = 100_000_000 * ONE_TOKEN; // 100,000,000 KPRS
pub const ALLOC_EARLY_KEEPERS: i128 = 40_000_000 * ONE_TOKEN; // 40,000,000 KPRS (40%)
pub const ALLOC_TREASURY: i128 = 25_000_000 * ONE_TOKEN; // 25,000,000 KPRS (25%)
pub const ALLOC_CORE_TEAM: i128 = 20_000_000 * ONE_TOKEN; // 20,000,000 KPRS (20%)
pub const ALLOC_PUBLIC: i128 = 15_000_000 * ONE_TOKEN; // 15,000,000 KPRS (15%)

// Team vesting parameters: 2 years (730 days) with 6 months (180 days) cliff
pub const TEAM_CLIFF_SECONDS: u64 = 180 * 24 * 60 * 60; // 15,552,000 s
pub const TEAM_VESTING_SECONDS: u64 = 730 * 24 * 60 * 60; // 63,072,000 s

#[contract]
pub struct GovernanceToken;

#[contractimpl]
impl GovernanceToken {
    /// Initializes the $KPRS governance token and mints the fixed 100M supply
    /// strictly according to the initial allocation breakdown:
    /// - 40% (40M KPRS) to early keepers retroactive distribution
    /// - 25% (25M KPRS) to protocol DAO treasury
    /// - 20% (20M KPRS) to core team with 2-year linear vesting & 6-month cliff
    /// - 15% (15M KPRS) to public & liquidity pool
    pub fn initialize(
        env: Env,
        admin: Address,
        early_keepers: Address,
        treasury: Address,
        core_team: Address,
        public_distribution: Address,
    ) -> Result<(), TokenError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(TokenError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().extend_ttl(100_000, 300_000);

        // Distribute 40% to Early Keepers / Community
        Self::set_balance(&env, &early_keepers, ALLOC_EARLY_KEEPERS);
        env.events().publish(
            (Symbol::new(&env, "mint"), admin.clone(), early_keepers.clone()),
            ALLOC_EARLY_KEEPERS,
        );

        // Distribute 25% to Treasury
        Self::set_balance(&env, &treasury, ALLOC_TREASURY);
        env.events().publish(
            (Symbol::new(&env, "mint"), admin.clone(), treasury.clone()),
            ALLOC_TREASURY,
        );

        // Distribute 20% to Core Team with on-chain vesting schedule
        Self::set_balance(&env, &core_team, ALLOC_CORE_TEAM);
        let start_time = env.ledger().timestamp();
        let team_vesting = VestingSchedule {
            total_amount: ALLOC_CORE_TEAM,
            start_time,
            cliff_duration: TEAM_CLIFF_SECONDS,
            total_duration: TEAM_VESTING_SECONDS,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Vesting(core_team.clone()), &team_vesting);

        env.events().publish(
            (Symbol::new(&env, "mint"), admin.clone(), core_team.clone()),
            ALLOC_CORE_TEAM,
        );

        // Distribute 15% to Public Distribution / Liquidity
        Self::set_balance(&env, &public_distribution, ALLOC_PUBLIC);
        env.events().publish(
            (
                Symbol::new(&env, "mint"),
                admin.clone(),
                public_distribution.clone(),
            ),
            ALLOC_PUBLIC,
        );

        Ok(())
    }

    // ── Standard Soroban Token Interface (SEP-41) ──────────────────────────

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let key = DataKey::Allowance(AllowanceDataKey { from, spender });
        if let Some(val) = env.storage().persistent().get::<DataKey, AllowanceValue>(&key) {
            if val.expiration_ledger >= env.ledger().sequence() {
                return val.amount;
            }
        }
        0
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), TokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        if expiration_ledger < env.ledger().sequence() {
            return Err(TokenError::InvalidExpiration);
        }

        let key = DataKey::Allowance(AllowanceDataKey {
            from: from.clone(),
            spender: spender.clone(),
        });

        if amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            let val = AllowanceValue {
                amount,
                expiration_ledger,
            };
            env.storage().persistent().set(&key, &val);
        }

        env.events().publish(
            (symbol_short!("approve"), from, spender),
            amount,
        );
        Ok(())
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn spendable_balance(env: Env, id: Address) -> i128 {
        let current_balance = Self::balance(env.clone(), id.clone());
        let unvested = Self::unvested_balance(env, id);
        let spendable = current_balance - unvested;
        if spendable < 0 {
            0
        } else {
            spendable
        }
    }

    pub fn vested_balance(env: Env, id: Address) -> i128 {
        let key = DataKey::Vesting(id.clone());
        let Some(schedule) = env.storage().persistent().get::<DataKey, VestingSchedule>(&key) else {
            return Self::balance(env, id);
        };

        let now = env.ledger().timestamp();
        if now < schedule.start_time + schedule.cliff_duration {
            0
        } else if now >= schedule.start_time + schedule.total_duration {
            schedule.total_amount
        } else {
            let elapsed = now - schedule.start_time;
            ((schedule.total_amount as i128) * (elapsed as i128)) / (schedule.total_duration as i128)
        }
    }

    pub fn unvested_balance(env: Env, id: Address) -> i128 {
        let key = DataKey::Vesting(id.clone());
        let Some(schedule) = env.storage().persistent().get::<DataKey, VestingSchedule>(&key) else {
            return 0;
        };

        let vested = Self::vested_balance(env, id);
        schedule.total_amount - vested
    }

    pub fn vesting_schedule(env: Env, id: Address) -> Option<VestingSchedule> {
        env.storage()
            .persistent()
            .get::<DataKey, VestingSchedule>(&DataKey::Vesting(id))
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        if amount == 0 {
            return Ok(());
        }

        // On-chain vesting enforcement: unvested tokens cannot be transferred
        let spendable = Self::spendable_balance(env.clone(), from.clone());
        if amount > spendable {
            return Err(TokenError::TokensLocked);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        let to_balance = Self::balance(env.clone(), to.clone());
        Self::set_balance(&env, &from, from_balance - amount);
        Self::set_balance(&env, &to, to_balance + amount);

        env.events().publish(
            (Symbol::new(&env, "transfer"), from, to),
            amount,
        );
        Ok(())
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        spender.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        if amount == 0 {
            return Ok(());
        }

        let current_allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current_allowance < amount {
            return Err(TokenError::InsufficientAllowance);
        }

        let spendable = Self::spendable_balance(env.clone(), from.clone());
        if amount > spendable {
            return Err(TokenError::TokensLocked);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        let to_balance = Self::balance(env.clone(), to.clone());
        Self::set_balance(&env, &from, from_balance - amount);
        Self::set_balance(&env, &to, to_balance + amount);

        // Deduct allowance
        let key = DataKey::Allowance(AllowanceDataKey {
            from: from.clone(),
            spender: spender.clone(),
        });
        let val = env.storage().persistent().get::<DataKey, AllowanceValue>(&key).unwrap();
        let next_val = AllowanceValue {
            amount: current_allowance - amount,
            expiration_ledger: val.expiration_ledger,
        };
        env.storage().persistent().set(&key, &next_val);

        env.events().publish(
            (Symbol::new(&env, "transfer"), from, to),
            amount,
        );
        Ok(())
    }

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        if amount == 0 {
            return Ok(());
        }

        let spendable = Self::spendable_balance(env.clone(), from.clone());
        if amount > spendable {
            return Err(TokenError::TokensLocked);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        Self::set_balance(&env, &from, from_balance - amount);

        env.events().publish(
            (Symbol::new(&env, "burn"), from),
            amount,
        );
        Ok(())
    }

    pub fn burn_from(
        env: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        spender.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        if amount == 0 {
            return Ok(());
        }

        let current_allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current_allowance < amount {
            return Err(TokenError::InsufficientAllowance);
        }

        let spendable = Self::spendable_balance(env.clone(), from.clone());
        if amount > spendable {
            return Err(TokenError::TokensLocked);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }

        Self::set_balance(&env, &from, from_balance - amount);

        let key = DataKey::Allowance(AllowanceDataKey {
            from: from.clone(),
            spender: spender.clone(),
        });
        let val = env.storage().persistent().get::<DataKey, AllowanceValue>(&key).unwrap();
        let next_val = AllowanceValue {
            amount: current_allowance - amount,
            expiration_ledger: val.expiration_ledger,
        };
        env.storage().persistent().set(&key, &next_val);

        env.events().publish(
            (Symbol::new(&env, "burn"), from),
            amount,
        );
        Ok(())
    }

    pub fn decimals(_env: Env) -> u32 {
        DECIMALS
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "Keeper Network Governance Token")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "KPRS")
    }

    pub fn total_supply(_env: Env) -> i128 {
        TOTAL_SUPPLY
    }

    /// Returns the historical balance of `id` at `ledger`, derived from checkpoints.
    pub fn balance_at(env: Env, id: Address, ledger: u32) -> i128 {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::CheckpointCount(id.clone()))
            .unwrap_or(0);
        if count == 0 {
            return 0;
        }

        let mut low = 0i64;
        let mut high = (count as i64) - 1;
        let mut ans = -1i64;

        while low <= high {
            let mid = low + (high - low) / 2;
            let cp: Checkpoint = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoint(id.clone(), mid as u32))
                .unwrap();
            if cp.ledger <= ledger {
                ans = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if ans >= 0 {
            let cp: Checkpoint = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoint(id.clone(), ans as u32))
                .unwrap();
            cp.balance
        } else {
            0
        }
    }

    // ── Internal Helpers ───────────────────────────────────────────────────

    fn set_balance(env: &Env, id: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &amount);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Balance(id.clone()), 100_000, 300_000);

        let current_ledger = env.ledger().sequence();
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::CheckpointCount(id.clone()))
            .unwrap_or(0);

        if count > 0 {
            let last_idx = count - 1;
            let last_cp: Checkpoint = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoint(id.clone(), last_idx))
                .unwrap();
            if last_cp.ledger == current_ledger {
                env.storage().persistent().set(
                    &DataKey::Checkpoint(id.clone(), last_idx),
                    &Checkpoint {
                        ledger: current_ledger,
                        balance: amount,
                    },
                );
                env.storage().persistent().extend_ttl(
                    &DataKey::Checkpoint(id.clone(), last_idx),
                    100_000,
                    300_000,
                );
                return;
            }
        }

        env.storage().persistent().set(
            &DataKey::Checkpoint(id.clone(), count),
            &Checkpoint {
                ledger: current_ledger,
                balance: amount,
            },
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Checkpoint(id.clone(), count),
            100_000,
            300_000,
        );
        env.storage()
            .persistent()
            .set(&DataKey::CheckpointCount(id.clone()), &(count + 1));
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::CheckpointCount(id.clone()), 100_000, 300_000);
    }
}

#[cfg(test)]
mod test;