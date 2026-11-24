#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum LendingError {
    PositionNotFound = 1,
    PositionHealthy = 2,
    PositionAlreadyLiquidated = 3,
    InvalidParams = 4,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub collateral_amount: i128,
    pub debt_amount: i128,
    pub collateral_price: i128,
    pub min_collateral_ratio_bps: u32, // e.g. 15000 = 150%
    pub is_liquidated: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Position(Address),
}

#[contractclient(name = "MockLendingClient")]
pub trait IMockLending {
    fn open_position(
        env: Env,
        borrower: Address,
        collateral_amount: i128,
        debt_amount: i128,
        collateral_price: i128,
        min_collateral_ratio_bps: u32,
    ) -> Result<(), LendingError>;

    fn update_price(env: Env, borrower: Address, new_price: i128) -> Result<(), LendingError>;

    fn is_liquidatable(env: Env, borrower: Address) -> bool;

    fn liquidate(env: Env, liquidator: Address, borrower: Address) -> Result<i128, LendingError>;

    fn get_position(env: Env, borrower: Address) -> Option<Position>;
}

#[contract]
pub struct MockLendingContract;

#[contractimpl]
impl MockLendingContract {
    pub fn open_position(
        env: Env,
        borrower: Address,
        collateral_amount: i128,
        debt_amount: i128,
        collateral_price: i128,
        min_collateral_ratio_bps: u32,
    ) -> Result<(), LendingError> {
        borrower.require_auth();
        if collateral_amount <= 0 || debt_amount <= 0 || collateral_price <= 0 {
            return Err(LendingError::InvalidParams);
        }

        let pos = Position {
            collateral_amount,
            debt_amount,
            collateral_price,
            min_collateral_ratio_bps,
            is_liquidated: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Position(borrower.clone()), &pos);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Position(borrower), 50_000, 100_000);
        Ok(())
    }

    pub fn update_price(env: Env, borrower: Address, new_price: i128) -> Result<(), LendingError> {
        let mut pos: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(borrower.clone()))
            .ok_or(LendingError::PositionNotFound)?;

        pos.collateral_price = new_price;
        env.storage()
            .persistent()
            .set(&DataKey::Position(borrower), &pos);
        Ok(())
    }

    pub fn is_liquidatable(env: Env, borrower: Address) -> bool {
        let pos: Position = match env
            .storage()
            .persistent()
            .get(&DataKey::Position(borrower))
        {
            Some(p) => p,
            None => return false,
        };

        if pos.is_liquidated {
            return false;
        }

        let collateral_val = pos.collateral_amount * pos.collateral_price;
        let required_val = (pos.debt_amount * pos.min_collateral_ratio_bps as i128) / 10_000;

        collateral_val < required_val
    }

    pub fn liquidate(env: Env, liquidator: Address, borrower: Address) -> Result<i128, LendingError> {
        liquidator.require_auth();

        let mut pos: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(borrower.clone()))
            .ok_or(LendingError::PositionNotFound)?;

        if pos.is_liquidated {
            return Err(LendingError::PositionAlreadyLiquidated);
        }

        let collateral_val = pos.collateral_amount * pos.collateral_price;
        let required_val = (pos.debt_amount * pos.min_collateral_ratio_bps as i128) / 10_000;

        if collateral_val >= required_val {
            return Err(LendingError::PositionHealthy);
        }

        // Seize collateral and mark liquidated
        let seized_collateral = pos.collateral_amount;
        pos.is_liquidated = true;
        pos.debt_amount = 0;
        pos.collateral_amount = 0;

        env.storage()
            .persistent()
            .set(&DataKey::Position(borrower), &pos);

        Ok(seized_collateral)
    }

    pub fn get_position(env: Env, borrower: Address) -> Option<Position> {
        env.storage().persistent().get(&DataKey::Position(borrower))
    }
}

#[cfg(test)]
mod test;
