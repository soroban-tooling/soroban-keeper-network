#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env,
};

/// Semantic version of the governance contract logic.
pub const VERSION: u32 = 1;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovernanceError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    NotInitialized = 3,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    KprsToken,
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initializes the governance contract with the admin and the KPRS token address.
    ///
    /// Following the scaffold-first discipline, this sets up the governance instance
    /// and wires the KPRS token contract dependency for voting power calculation.
    pub fn initialize(env: Env, admin: Address, kprs_token: Address) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::KprsToken, &kprs_token);
        env.storage().instance().set(&DataKey::Initialized, &true);

        Ok(())
    }

    /// Exposes the contract logic version view.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    /// Returns the contract admin address.
    pub fn admin(env: Env) -> Result<Address, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(GovernanceError::NotInitialized)
    }

    /// Returns the configured KPRS governance token address.
    pub fn kprs_token(env: Env) -> Result<Address, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::KprsToken)
            .ok_or(GovernanceError::NotInitialized)
    }

    /// Reads the voting power for a given account directly from the configured
    /// KPRS token contract balance.
    ///
    /// This dependency is wired according to Issue #490 (issue 0361) and ready
    /// for proposal and voting logic execution in subsequent governance issues.
    pub fn get_voting_power(env: Env, account: Address) -> Result<i128, GovernanceError> {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::KprsToken)
            .ok_or(GovernanceError::NotInitialized)?;

        let token_client = token::Client::new(&env, &token_addr);
        Ok(token_client.balance(&account))
    }
}

#[cfg(test)]
mod test;
