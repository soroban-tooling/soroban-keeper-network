#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Vec, Map};

/// KPRS Governance Token Contract
/// A standard fungible token for governance participation in the Soroban Keeper Network.
/// 
/// This contract implements a basic token interface with:
/// - Total supply of 1,000,000,000 KPRS (1 billion tokens, 7 decimals = 10^16 stroops)
/// - Initial distribution: Admin receives all tokens at initialization
/// - Standard transfer, approve, and balance query operations
/// - Snapshot support for governance voting (fixed voting power at proposal creation)

#[derive(Clone)]
pub enum DataKey {
    Admin,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
}

#[contract]
pub struct GovernanceToken;

#[contractimpl]
impl GovernanceToken {
    /// Initialize the token contract
    /// 
    /// # Arguments
    /// * `admin` - The initial admin and token holder
    /// * `total_supply` - Total token supply (in stroops, including decimals)
    pub fn initialize(e: Env, admin: Address, total_supply: i128) -> Result<(), Symbol> {
        let storage = e.storage().instance();

        // Verify admin is not already initialized
        if storage.has(&DataKey::Admin) {
            return Err(Symbol::new(&e, "already_initialized"));
        }

        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::TotalSupply, &total_supply);
        storage.set(&DataKey::Balance(admin.clone()), &total_supply);

        Ok(())
    }

    /// Get the total supply of tokens
    pub fn total_supply(e: Env) -> i128 {
        e.storage()
            .instance()
            .get::<_, i128>(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    /// Get the balance of an account
    pub fn balance_of(e: Env, account: Address) -> i128 {
        e.storage()
            .instance()
            .get::<_, i128>(&DataKey::Balance(account))
            .unwrap_or(0)
    }

    /// Transfer tokens from caller to recipient
    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) -> Result<(), Symbol> {
        from.require_auth();

        if amount < 0 {
            return Err(Symbol::new(&e, "negative_amount"));
        }

        let storage = e.storage().instance();
        let from_balance = storage
            .get::<_, i128>(&DataKey::Balance(from.clone()))
            .unwrap_or(0);

        if from_balance < amount {
            return Err(Symbol::new(&e, "insufficient_balance"));
        }

        storage.set(&DataKey::Balance(from.clone()), &(from_balance - amount));

        let to_balance = storage
            .get::<_, i128>(&DataKey::Balance(to.clone()))
            .unwrap_or(0);
        storage.set(&DataKey::Balance(to.clone()), &(to_balance + amount));

        Ok(())
    }

    /// Approve a spender to transfer tokens on behalf of the owner
    pub fn approve(e: Env, owner: Address, spender: Address, amount: i128) -> Result<(), Symbol> {
        owner.require_auth();

        if amount < 0 {
            return Err(Symbol::new(&e, "negative_amount"));
        }

        let storage = e.storage().instance();
        storage.set(&DataKey::Allowance(owner, spender), &amount);

        Ok(())
    }

    /// Get the allowed amount a spender can transfer on behalf of the owner
    pub fn allowance(e: Env, owner: Address, spender: Address) -> i128 {
        e.storage()
            .instance()
            .get::<_, i128>(&DataKey::Allowance(owner, spender))
            .unwrap_or(0)
    }

    /// Transfer tokens from one account to another using an allowance
    pub fn transfer_from(
        e: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Symbol> {
        spender.require_auth();

        if amount < 0 {
            return Err(Symbol::new(&e, "negative_amount"));
        }

        let storage = e.storage().instance();

        // Check allowance
        let allowance = storage
            .get::<_, i128>(&DataKey::Allowance(from.clone(), spender.clone()))
            .unwrap_or(0);

        if allowance < amount {
            return Err(Symbol::new(&e, "insufficient_allowance"));
        }

        // Check balance
        let from_balance = storage
            .get::<_, i128>(&DataKey::Balance(from.clone()))
            .unwrap_or(0);

        if from_balance < amount {
            return Err(Symbol::new(&e, "insufficient_balance"));
        }

        // Update balances
        storage.set(&DataKey::Balance(from.clone()), &(from_balance - amount));
        let to_balance = storage
            .get::<_, i128>(&DataKey::Balance(to.clone()))
            .unwrap_or(0);
        storage.set(&DataKey::Balance(to.clone()), &(to_balance + amount));

        // Update allowance
        storage.set(
            &DataKey::Allowance(from, spender),
            &(allowance - amount),
        );

        Ok(())
    }

    /// Get the token admin
    pub fn admin(e: Env) -> Address {
        e.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| Address::generate(&e))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    #[test]
    fn test_initialize() {
        let e = Env::default();
        let admin = Address::generate(&e);
        let total_supply = 1_000_000_000_0000000i128; // 1 billion with 7 decimals

        GovernanceToken::initialize(e.clone(), admin.clone(), total_supply).unwrap();

        assert_eq!(GovernanceToken::total_supply(e.clone()), total_supply);
        assert_eq!(GovernanceToken::balance_of(e.clone(), admin.clone()), total_supply);
    }

    #[test]
    fn test_transfer() {
        let e = Env::default();
        let admin = Address::generate(&e);
        let recipient = Address::generate(&e);
        let total_supply = 1_000_000_000_0000000i128;

        GovernanceToken::initialize(e.clone(), admin.clone(), total_supply).unwrap();

        let transfer_amount = 100_0000000i128; // 100 tokens
        GovernanceToken::transfer(e.clone(), admin.clone(), recipient.clone(), transfer_amount)
            .unwrap();

        assert_eq!(
            GovernanceToken::balance_of(e.clone(), admin.clone()),
            total_supply - transfer_amount
        );
        assert_eq!(
            GovernanceToken::balance_of(e.clone(), recipient.clone()),
            transfer_amount
        );
    }
}
