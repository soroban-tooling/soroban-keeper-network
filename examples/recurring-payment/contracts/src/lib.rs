#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SubscriptionError {
    NotInitialized = 1,
    PaymentNotDueYet = 2,
    MaxPeriodsReached = 3,
    SubscriptionInactive = 4,
    Unauthorized = 5,
    InvalidParameters = 6,
    NotFound = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub id: u64,
    pub subscriber: Address,
    pub merchant: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_ledgers: u32,
    pub last_payment_ledger: u32,
    pub paid_periods: u32,
    pub max_periods: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    SubscriptionCount,
    Sub(u64),
}

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// Create a new recurring subscription between subscriber and merchant.
    pub fn create_subscription(
        env: Env,
        subscriber: Address,
        merchant: Address,
        token: Address,
        amount: i128,
        interval_ledgers: u32,
        max_periods: u32,
    ) -> Result<u64, SubscriptionError> {
        subscriber.require_auth();

        if amount <= 0 || interval_ledgers == 0 || max_periods == 0 {
            return Err(SubscriptionError::InvalidParameters);
        }

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SubscriptionCount)
            .unwrap_or(0);
        count = count.saturating_add(1);

        let current_ledger = env.ledger().sequence();

        let sub = Subscription {
            id: count,
            subscriber: subscriber.clone(),
            merchant: merchant.clone(),
            token,
            amount,
            interval_ledgers,
            // Last payment is set to current ledger minus interval so period 1 can be claimed immediately,
            // or current ledger if first payment is executed upon creation.
            last_payment_ledger: current_ledger,
            paid_periods: 0,
            max_periods,
            active: true,
        };

        env.storage().instance().set(&DataKey::SubscriptionCount, &count);
        env.storage().persistent().set(&DataKey::Sub(count), &sub);

        // Keep subscription storage live
        env.storage().persistent().extend_ttl(&DataKey::Sub(count), 1000, 100000);

        env.events().publish(
            (symbol_short!("sub_new"),),
            (count, subscriber, merchant, amount),
        );

        Ok(count)
    }

    /// Execute a period's subscription payment. Callable permissionlessly by keepers.
    ///
    /// CRITICAL CRITERION: The contract REFUSES double payment within the same period!
    pub fn execute_payment(env: Env, subscription_id: u64) -> Result<u32, SubscriptionError> {
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .ok_or(SubscriptionError::NotFound)?;

        if !sub.active {
            return Err(SubscriptionError::SubscriptionInactive);
        }

        if sub.paid_periods >= sub.max_periods {
            return Err(SubscriptionError::MaxPeriodsReached);
        }

        let current_ledger = env.ledger().sequence();

        // Check period threshold:
        // For period 1, if paid_periods == 0 and last_payment_ledger == creation_ledger,
        // it requires current_ledger >= last_payment_ledger + interval_ledgers.
        let next_due_ledger = sub
            .last_payment_ledger
            .checked_add(sub.interval_ledgers)
            .ok_or(SubscriptionError::InvalidParameters)?;

        if current_ledger < next_due_ledger {
            // REFUSE DOUBLE PAYMENT WITHIN PERIOD
            return Err(SubscriptionError::PaymentNotDueYet);
        }

        // Execute payment transfer from subscriber to merchant
        let token_client = token::Client::new(&env, &sub.token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &sub.subscriber,
            &sub.merchant,
            &sub.amount,
        );

        sub.paid_periods = sub.paid_periods.saturating_add(1);
        sub.last_payment_ledger = current_ledger;

        if sub.paid_periods >= sub.max_periods {
            sub.active = false;
        }

        env.storage().persistent().set(&DataKey::Sub(subscription_id), &sub);

        env.events().publish(
            (symbol_short!("sub_pay"),),
            (subscription_id, sub.paid_periods, sub.amount, current_ledger),
        );

        Ok(sub.paid_periods)
    }

    /// Cancel subscription (subscriber only).
    pub fn cancel_subscription(
        env: Env,
        subscriber: Address,
        subscription_id: u64,
    ) -> Result<(), SubscriptionError> {
        subscriber.require_auth();

        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .ok_or(SubscriptionError::NotFound)?;

        if sub.subscriber != subscriber {
            return Err(SubscriptionError::Unauthorized);
        }

        sub.active = false;
        env.storage().persistent().set(&DataKey::Sub(subscription_id), &sub);

        env.events().publish(
            (symbol_short!("sub_stop"),),
            (subscription_id, subscriber),
        );

        Ok(())
    }

    /// Read subscription details.
    pub fn get_subscription(env: Env, subscription_id: u64) -> Result<Subscription, SubscriptionError> {
        env.storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .ok_or(SubscriptionError::NotFound)
    }
}

#[cfg(test)]
mod test;
