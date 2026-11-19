#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovernanceError {
    NotFound = 1,
    ProposalNotQueued = 2,
    TimelockNotElapsed = 3,
    ProposalAlreadyExecuted = 4,
    InvalidEta = 5,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalStatus {
    Queued = 1,
    Executed = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub eta: u64, // Execution timestamp / ledger threshold
    pub target: Address,
    pub action_data: Symbol,
    pub status: ProposalStatus,
    pub executed_by: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Proposal(u64),
}

#[contract]
pub struct GovernanceExecutionContract;

#[contractimpl]
impl GovernanceExecutionContract {
    /// Queues a passed governance proposal with a timelock ETA.
    pub fn queue_proposal(
        env: Env,
        proposal_id: u64,
        eta: u64,
        target: Address,
        action_data: Symbol,
    ) -> Result<(), GovernanceError> {
        if eta <= env.ledger().timestamp() {
            return Err(GovernanceError::InvalidEta);
        }

        let proposal = Proposal {
            id: proposal_id,
            eta,
            target,
            action_data,
            status: ProposalStatus::Queued,
            executed_by: None,
        };

        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage().persistent().extend_ttl(&DataKey::Proposal(proposal_id), 1000, 100000);

        env.events().publish(
            (symbol_short!("gov_queue"),),
            (proposal_id, eta),
        );

        Ok(())
    }

    /// Execute passed proposal: callable permissionlessly by any keeper bot once timelock elapses.
    ///
    /// CRITICAL CRITERION 2: Execution before the timelock fails on-chain!
    pub fn execute_proposal(env: Env, proposal_id: u64, keeper: Address) -> Result<(), GovernanceError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::NotFound)?;

        if proposal.status != ProposalStatus::Queued {
            return Err(GovernanceError::ProposalNotQueued);
        }

        let current_time = env.ledger().timestamp();

        // 1. CRITICAL CHECK: Refuse execution before timelock elapses!
        if current_time < proposal.eta {
            return Err(GovernanceError::TimelockNotElapsed);
        }

        proposal.status = ProposalStatus::Executed;
        proposal.executed_by = Some(keeper.clone());

        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("gov_exec"),),
            (proposal_id, keeper, proposal.eta),
        );

        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::NotFound)
    }
}

#[cfg(test)]
mod test;
