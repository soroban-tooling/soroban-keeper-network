#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VestingError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    CliffNotReached = 3,
    TrancheNotReached = 4,
    AllVestedAlready = 5,
    InvalidSchedule = 6,
    ZeroAmount = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub beneficiary: Address,
    pub token: Address,
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_timestamp: u64,
    pub cliff_timestamp: u64,
    pub num_tranches: u32,
    pub tranche_interval_seconds: u64,
    pub last_released_tranche: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Schedule,
}

#[contract]
pub struct VestingContract;

#[contractimpl]
impl VestingContract {
    /// Initialize vesting contract with tokens deposited by sender.
    pub fn initialize(
        env: Env,
        sender: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_timestamp: u64,
        cliff_timestamp: u64,
        num_tranches: u32,
        tranche_interval_seconds: u64,
    ) -> Result<(), VestingError> {
        if env.storage().instance().has(&DataKey::Schedule) {
            return Err(VestingError::AlreadyInitialized);
        }

        sender.require_auth();

        if total_amount <= 0 {
            return Err(VestingError::ZeroAmount);
        }
        if cliff_timestamp < start_timestamp || num_tranches == 0 || tranche_interval_seconds == 0 {
            return Err(VestingError::InvalidSchedule);
        }

        // Transfer vesting pool tokens into contract custody
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &total_amount);

        let schedule = VestingSchedule {
            beneficiary: beneficiary.clone(),
            token,
            total_amount,
            released_amount: 0,
            start_timestamp,
            cliff_timestamp,
            num_tranches,
            tranche_interval_seconds,
            last_released_tranche: 0,
        };

        env.storage().instance().set(&DataKey::Schedule, &schedule);
        env.storage().instance().extend_ttl(1000, 100000);

        env.events().publish(
            (symbol_short!("v_init"),),
            (beneficiary, total_amount, cliff_timestamp),
        );

        Ok(())
    }

    /// Triggered by keeper (or anyone) to release matured tranches to the beneficiary.
    ///
    /// CRITICAL CRITERION:
    /// Releases before their date are strictly REFUSED by the contract, not just the keeper!
    pub fn release(env: Env) -> Result<i128, VestingError> {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule)
            .ok_or(VestingError::NotInitialized)?;

        let current_time = env.ledger().timestamp();

        // 1. REFUSE BEFORE CLIFF DATE
        if current_time < schedule.cliff_timestamp {
            return Err(VestingError::CliffNotReached);
        }

        // 2. CHECK IF EVERYTHING IS ALREADY RELEASED
        if schedule.released_amount >= schedule.total_amount {
            return Err(VestingError::AllVestedAlready);
        }

        // 3. CALCULATE TRANCHES ELAPSED
        let elapsed = current_time.saturating_sub(schedule.start_timestamp);
        let tranches_elapsed_u64 = elapsed / schedule.tranche_interval_seconds;
        let tranches_elapsed = tranches_elapsed_u64.min(schedule.num_tranches as u64) as u32;

        let total_vested = (schedule.total_amount * (tranches_elapsed as i128))
            / (schedule.num_tranches as i128);

        let releasable = total_vested.saturating_sub(schedule.released_amount);

        // 4. REFUSE IF NO NEW TRANCHE HAS MATURED YET
        if releasable <= 0 {
            return Err(VestingError::TrancheNotReached);
        }

        // Transfer newly vested tokens to beneficiary
        let token_client = token::Client::new(&env, &schedule.token);
        token_client.transfer(
            &env.current_contract_address(),
            &schedule.beneficiary,
            &releasable,
        );

        schedule.released_amount = schedule.released_amount.saturating_add(releasable);
        schedule.last_released_tranche = tranches_elapsed;

        env.storage().instance().set(&DataKey::Schedule, &schedule);

        env.events().publish(
            (symbol_short!("v_rel"),),
            (schedule.beneficiary.clone(), releasable, tranches_elapsed),
        );

        Ok(releasable)
    }

    /// View schedule status and calculate currently releasable amount.
    pub fn get_schedule(env: Env) -> Result<VestingSchedule, VestingError> {
        env.storage()
            .instance()
            .get(&DataKey::Schedule)
            .ok_or(VestingError::NotInitialized)
    }

    /// Read how much would be released right now without mutating state.
    pub fn get_releasable(env: Env) -> Result<i128, VestingError> {
        let schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule)
            .ok_or(VestingError::NotInitialized)?;

        let current_time = env.ledger().timestamp();
        if current_time < schedule.cliff_timestamp {
            return Ok(0);
        }

        let elapsed = current_time.saturating_sub(schedule.start_timestamp);
        let tranches_elapsed = (elapsed / schedule.tranche_interval_seconds)
            .min(schedule.num_tranches as u64) as u32;

        let total_vested = (schedule.total_amount * (tranches_elapsed as i128))
            / (schedule.num_tranches as i128);

        Ok(total_vested.saturating_sub(schedule.released_amount))
    }
}

#[cfg(test)]
mod test;
