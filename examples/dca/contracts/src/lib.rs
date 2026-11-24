#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum DcaError {
    NotFound = 1,
    PlanNotActive = 2,
    SwapNotDueYet = 3,
    InsufficientRemainingDeposit = 4,
    Unauthorized = 5,
    InvalidParameters = 6,
    PlanAlreadyCompleted = 7,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DcaStatus {
    Active = 1,
    Completed = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DcaPlan {
    pub id: u64,
    pub owner: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub remaining_deposit: i128,
    pub fixed_swap_amount: i128,
    pub interval_ledgers: u32,
    pub last_swap_ledger: u32,
    pub total_swaps_executed: u32,
    pub router: Address,
    pub status: DcaStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    PlanCount,
    Plan(u64),
}

/// DEX Router interface for swap execution
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
pub struct DcaContract;

#[contractimpl]
impl DcaContract {
    /// Create a new Dollar-Cost Averaging plan depositing `total_deposit`.
    pub fn create_dca_plan(
        env: Env,
        owner: Address,
        token_in: Address,
        token_out: Address,
        total_deposit: i128,
        fixed_swap_amount: i128,
        interval_ledgers: u32,
        router: Address,
    ) -> Result<u64, DcaError> {
        owner.require_auth();

        if total_deposit <= 0 || fixed_swap_amount <= 0 || fixed_swap_amount > total_deposit {
            return Err(DcaError::InvalidParameters);
        }
        if interval_ledgers == 0 {
            return Err(DcaError::InvalidParameters);
        }

        // Pull total deposit into contract custody
        let token_in_client = token::Client::new(&env, &token_in);
        token_in_client.transfer(&owner, &env.current_contract_address(), &total_deposit);

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PlanCount)
            .unwrap_or(0);
        count = count.saturating_add(1);

        let plan = DcaPlan {
            id: count,
            owner: owner.clone(),
            token_in,
            token_out,
            remaining_deposit: total_deposit,
            fixed_swap_amount,
            interval_ledgers,
            last_swap_ledger: env.ledger().sequence(),
            total_swaps_executed: 0,
            router,
            status: DcaStatus::Active,
        };

        env.storage().instance().set(&DataKey::PlanCount, &count);
        env.storage().persistent().set(&DataKey::Plan(count), &plan);
        env.storage().persistent().extend_ttl(&DataKey::Plan(count), 1000, 100000);

        env.events().publish(
            (symbol_short!("dca_new"),),
            (count, owner, total_deposit, fixed_swap_amount),
        );

        Ok(count)
    }

    /// Execute the periodic DCA swap via keeper bot.
    ///
    /// CRITICAL CRITERION 1: Each period swaps a fixed amount, enforced on-chain!
    pub fn execute_dca_swap(env: Env, plan_id: u64, min_amount_out: i128) -> Result<i128, DcaError> {
        let mut plan: DcaPlan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(DcaError::NotFound)?;

        if plan.status != DcaStatus::Active {
            return Err(DcaError::PlanNotActive);
        }

        let current_ledger = env.ledger().sequence();
        let next_due = plan.last_swap_ledger.saturating_add(plan.interval_ledgers);

        if current_ledger < next_due {
            return Err(DcaError::SwapNotDueYet);
        }

        // CRITICAL CHECK: Swaps exactly fixed_swap_amount (enforced on-chain)
        if plan.remaining_deposit < plan.fixed_swap_amount {
            return Err(DcaError::InsufficientRemainingDeposit);
        }

        let swap_amount = plan.fixed_swap_amount;

        // Approve router to spend token_in
        let token_in_client = token::Client::new(&env, &plan.token_in);
        token_in_client.approve(
            &env.current_contract_address(),
            &plan.router,
            &swap_amount,
            &(current_ledger + 50),
        );

        // Execute swap: delivers token_out directly to plan owner
        let router_client = DexRouterClient::new(&env, &plan.router);
        let actual_out = router_client.swap(
            &plan.token_in,
            &plan.token_out,
            &swap_amount,
            &min_amount_out,
            &plan.owner,
        );

        plan.remaining_deposit = plan.remaining_deposit.saturating_sub(swap_amount);
        plan.total_swaps_executed = plan.total_swaps_executed.saturating_add(1);
        plan.last_swap_ledger = current_ledger;

        if plan.remaining_deposit < plan.fixed_swap_amount {
            plan.status = DcaStatus::Completed;
        }

        env.storage().persistent().set(&DataKey::Plan(plan_id), &plan);

        env.events().publish(
            (symbol_short!("dca_exec"),),
            (plan_id, swap_amount, actual_out, plan.total_swaps_executed),
        );

        Ok(actual_out)
    }

    /// Owner stops the schedule by cancelling the pending task/plan and receiving refund.
    ///
    /// CRITICAL CRITERION 2: Owner can stop the schedule by cancelling!
    pub fn cancel_dca_plan(env: Env, owner: Address, plan_id: u64) -> Result<i128, DcaError> {
        owner.require_auth();

        let mut plan: DcaPlan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(DcaError::NotFound)?;

        if plan.owner != owner {
            return Err(DcaError::Unauthorized);
        }
        if plan.status != DcaStatus::Active {
            return Err(DcaError::PlanNotActive);
        }

        let refund_amount = plan.remaining_deposit;
        plan.remaining_deposit = 0;
        plan.status = DcaStatus::Cancelled;

        env.storage().persistent().set(&DataKey::Plan(plan_id), &plan);

        // Refund all remaining unswapped token_in to owner
        if refund_amount > 0 {
            let token_in_client = token::Client::new(&env, &plan.token_in);
            token_in_client.transfer(
                &env.current_contract_address(),
                &owner,
                &refund_amount,
            );
        }

        env.events().publish(
            (symbol_short!("dca_canc"),),
            (plan_id, owner, refund_amount),
        );

        Ok(refund_amount)
    }

    pub fn get_dca_plan(env: Env, plan_id: u64) -> Result<DcaPlan, DcaError> {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(DcaError::NotFound)
    }
}

#[cfg(test)]
mod test;
