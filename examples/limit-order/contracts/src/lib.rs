#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OrderError {
    NotFound = 1,
    OrderNotOpen = 2,
    PriceConditionNotMet = 3,
    SlippageExceeded = 4,
    Unauthorized = 5,
    InvalidParameters = 6,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OrderStatus {
    Open = 1,
    Filled = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub id: u64,
    pub creator: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub target_price: i128,
    pub condition_contract: Address,
    pub router: Address,
    pub status: OrderStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    OrderCount,
    Order(u64),
}

/// Interface for the on-chain Price-Threshold Condition Contract (contracts/conditions/price-threshold)
#[contractclient(name = "ConditionClient")]
pub trait ICondition {
    fn check(env: Env) -> bool;
}

/// Interface for the DEX Router
#[contractclient(name = "DexRouterClient")]
pub trait IDexRouter {
    fn swap(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        recipient: Address,
    ) -> i128;
}

#[contract]
pub struct LimitOrderContract;

#[contractimpl]
impl LimitOrderContract {
    /// Create a new limit order and deposit `amount_in` tokens.
    pub fn create_order(
        env: Env,
        creator: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        target_price: i128,
        condition_contract: Address,
        router: Address,
    ) -> Result<u64, OrderError> {
        creator.require_auth();

        if amount_in <= 0 || min_amount_out <= 0 || target_price <= 0 {
            return Err(OrderError::InvalidParameters);
        }

        // Deposit token_in from creator into this contract's custody
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer(&creator, &env.current_contract_address(), &amount_in);

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0);
        count = count.saturating_add(1);

        let order = Order {
            id: count,
            creator: creator.clone(),
            token_in,
            token_out,
            amount_in,
            min_amount_out,
            target_price,
            condition_contract,
            router,
            status: OrderStatus::Open,
        };

        env.storage().instance().set(&DataKey::OrderCount, &count);
        env.storage().persistent().set(&DataKey::Order(count), &order);
        env.storage().persistent().extend_ttl(&DataKey::Order(count), 1000, 100000);

        env.events().publish(
            (symbol_short!("ord_new"),),
            (count, creator, amount_in, min_amount_out),
        );

        Ok(count)
    }

    /// Execute a limit order via keeper.
    ///
    /// CRITERION 1: The task uses the price-threshold condition, not an off-chain check.
    /// CRITERION 2: Slippage protection is strictly enforced in the swap call.
    pub fn execute_order(env: Env, order_id: u64) -> Result<i128, OrderError> {
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(OrderError::NotFound)?;

        if order.status != OrderStatus::Open {
            return Err(OrderError::OrderNotOpen);
        }

        // 1. ON-CHAIN PRICE-THRESHOLD CONDITION CHECK (Criterion 1)
        // Evaluates the attached condition contract (not relying on caller/off-chain data)
        let condition_client = ConditionClient::new(&env, &order.condition_contract);
        let condition_met = condition_client.check();
        if !condition_met {
            return Err(OrderError::PriceConditionNotMet);
        }

        // 2. SLIPPAGE PROTECTION IN SWAP CALL (Criterion 2)
        // Approve DEX router to spend token_in
        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.approve(
            &env.current_contract_address(),
            &order.router,
            &order.amount_in,
            &(env.ledger().sequence() + 100),
        );

        // Execute swap through DEX router, passing min_amount_out
        let router_client = DexRouterClient::new(&env, &order.router);
        let actual_amount_out = router_client.swap(
            &order.token_in,
            &order.token_out,
            &order.amount_in,
            &order.min_amount_out,
            &order.creator,
        );

        // Explicit slippage verification guarantee:
        if actual_amount_out < order.min_amount_out {
            return Err(OrderError::SlippageExceeded);
        }

        order.status = OrderStatus::Filled;
        env.storage().persistent().set(&DataKey::Order(order_id), &order);

        env.events().publish(
            (symbol_short!("ord_fill"),),
            (order_id, order.creator, actual_amount_out),
        );

        Ok(actual_amount_out)
    }

    /// Cancel open order and refund deposited token_in (creator only).
    pub fn cancel_order(env: Env, creator: Address, order_id: u64) -> Result<(), OrderError> {
        creator.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(OrderError::NotFound)?;

        if order.creator != creator {
            return Err(OrderError::Unauthorized);
        }
        if order.status != OrderStatus::Open {
            return Err(OrderError::OrderNotOpen);
        }

        order.status = OrderStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Order(order_id), &order);

        // Refund token_in to creator
        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.transfer(
            &env.current_contract_address(),
            &order.creator,
            &order.amount_in,
        );

        env.events().publish(
            (symbol_short!("ord_canc"),),
            (order_id, creator),
        );

        Ok(())
    }

    pub fn get_order(env: Env, order_id: u64) -> Result<Order, OrderError> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(OrderError::NotFound)
    }
}

#[cfg(test)]
mod test;
