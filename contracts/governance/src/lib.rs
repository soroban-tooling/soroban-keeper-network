#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, token, Address, Env,
};

pub mod events;
pub use events::*;

/// Semantic version of the governance contract logic.
pub const VERSION: u32 = 1;

#[contractclient(name = "KeeperRegistryClient")]
pub trait IKeeperRegistry {
    fn set_fee_bps(env: Env, admin: Address, new_bps: u32);
    fn set_min_reward(env: Env, admin: Address, min_reward: i128);
    fn set_reputation_floor(env: Env, admin: Address, floor_bps: u32);
    fn pause(env: Env, admin: Address);
    fn unpause(env: Env, admin: Address);
    fn transfer_admin(env: Env, admin: Address, new_admin: Address);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernableAction {
    SetFeeBps(u32),
    SetMinReward(i128),
    SetReputationFloor(u32),
    Pause,
    Unpause,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalStatus {
    Pending = 0,
    Active = 1,
    Defeated = 2,
    Succeeded = 3,
    Queued = 4,
    Executed = 5,
    Cancelled = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action: GovernableAction,
    pub eta: u64,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteReceipt {
    pub voter: Address,
    pub support: u32,
    pub voting_power: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovernanceError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    NotInitialized = 3,
    ProposalNotFound = 4,
    ProposalAlreadyExecuted = 5,
    ProposalNotQueued = 6,
    TimelockNotElapsed = 7,
    RegistryCallFailed = 8,
    AlreadyVoted = 9,
    ProposalNotActive = 10,
    InvalidSupportValue = 11,
    ProposalAlreadyCancelled = 12,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    KprsToken,
    Registry,
    Proposal(u64),
    ProposalCount,
    Vote(u64, Address),
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initializes the governance contract with admin, KPRS token address, and registry address.
    pub fn initialize(
        env: Env,
        admin: Address,
        kprs_token: Address,
        registry: Address,
    ) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::KprsToken, &kprs_token);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
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

    /// Returns the configured KeeperRegistry address.
    pub fn registry(env: Env) -> Result<Address, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(GovernanceError::NotInitialized)
    }

    /// Reads voting power from the configured KPRS token contract for an account.
    pub fn get_voting_power(env: Env, account: Address) -> Result<i128, GovernanceError> {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::KprsToken)
            .ok_or(GovernanceError::NotInitialized)?;

        let token_client = token::Client::new(&env, &token_addr);
        Ok(token_client.balance(&account))
    }

    /// Creates and queues a proposal for execution after the specified timelock ETA.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        action: GovernableAction,
        eta: u64,
    ) -> Result<u64, GovernanceError> {
        proposer.require_auth();

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            action,
            eta,
            status: ProposalStatus::Queued,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        emit_proposal_created(&env, proposal_id, &proposer, eta);
        emit_proposal_queued(&env, proposal_id, eta);

        Ok(proposal_id)
    }

    /// Casts an individual vote on an active or queued proposal.
    ///
    /// # Voter Transparency vs Privacy
    /// Emits `VoteCast` containing `(proposal_id, voter, support, voting_power)`.
    /// In an open DAO governance architecture, individual votes are publicly auditable
    /// on-chain to provide full cryptographic verifiability of tallies, maintain stakeholder
    /// accountability, and support per-voter activity feeds.
    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: u32,
    ) -> Result<i128, GovernanceError> {
        voter.require_auth();

        if support > 2 {
            return Err(GovernanceError::InvalidSupportValue);
        }

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active && proposal.status != ProposalStatus::Queued {
            return Err(GovernanceError::ProposalNotActive);
        }

        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(GovernanceError::AlreadyVoted);
        }

        let voting_power = Self::get_voting_power(env.clone(), voter.clone())?;

        let receipt = VoteReceipt {
            voter: voter.clone(),
            support,
            voting_power,
        };
        env.storage().persistent().set(&vote_key, &receipt);

        emit_vote_cast(&env, proposal_id, &voter, support, voting_power);

        Ok(voting_power)
    }

    /// Records the voting outcome (passed or defeated) for a proposal.
    pub fn record_outcome(
        env: Env,
        proposal_id: u64,
        passed: bool,
        votes_for: i128,
        votes_against: i128,
        votes_abstain: i128,
    ) -> Result<(), GovernanceError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if passed {
            proposal.status = ProposalStatus::Queued;
            env.storage()
                .persistent()
                .set(&DataKey::Proposal(proposal_id), &proposal);

            emit_proposal_passed(&env, proposal_id, votes_for, votes_against, votes_abstain);
            emit_proposal_queued(&env, proposal_id, proposal.eta);
        } else {
            proposal.status = ProposalStatus::Defeated;
            env.storage()
                .persistent()
                .set(&DataKey::Proposal(proposal_id), &proposal);

            emit_proposal_defeated(&env, proposal_id, votes_for, votes_against, votes_abstain);
        }

        Ok(())
    }

    /// Cancels an open or queued proposal. Can only be cancelled by the proposer or admin.
    pub fn cancel_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(GovernanceError::NotInitialized)?;

        if caller != proposal.proposer && caller != admin {
            return Err(GovernanceError::Unauthorized);
        }

        if proposal.status == ProposalStatus::Executed {
            return Err(GovernanceError::ProposalAlreadyExecuted);
        }
        if proposal.status == ProposalStatus::Cancelled {
            return Err(GovernanceError::ProposalAlreadyCancelled);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        emit_proposal_cancelled(&env, proposal_id);

        Ok(())
    }

    /// Retrieves a proposal by its unique ID.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Executes a passed, queued proposal against the registry.
    ///
    /// # Checks-Effects-Interactions (CEI) Guarantees
    /// 1. **CHECKS**: Validates that the proposal exists, is strictly in `Queued` status,
    ///    is not already `Executed`, and that the timelock ETA has elapsed.
    /// 2. **EFFECTS**: Updates proposal status to `Executed` in persistent storage
    ///    **BEFORE** any cross-contract interaction. This prevents reentrancy and
    ///    double execution attacks.
    /// 3. **INTERACTIONS**: Invokes the cross-contract call on the registry.
    ///    If the registry call fails validation (e.g. invalid fee_bps > 10,000) or reverts,
    ///    the proposal is restored to its recoverable `Queued` state rather than silently
    ///    being marked as `Executed` without the change actually landing.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), GovernanceError> {
        // ── 1. CHECKS ───────────────────────────────────────────────────────────
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(GovernanceError::ProposalAlreadyExecuted);
        }
        if proposal.status != ProposalStatus::Queued {
            return Err(GovernanceError::ProposalNotQueued);
        }

        let now = env.ledger().timestamp();
        if now < proposal.eta {
            return Err(GovernanceError::TimelockNotElapsed);
        }

        let registry_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(GovernanceError::NotInitialized)?;

        // ── 2. EFFECTS ──────────────────────────────────────────────────────────
        // State updated to Executed in persistent storage BEFORE cross-contract dispatch.
        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // ── 3. INTERACTIONS ─────────────────────────────────────────────────────
        let execution_result = Self::dispatch_registry_call(&env, &registry_addr, &proposal.action);

        match execution_result {
            Ok(()) => {
                emit_proposal_executed(&env, proposal_id);
                Ok(())
            }
            Err(err) => {
                // If the underlying registry call failed, leave proposal in a recoverable
                // state (Queued), not silently marked executed when change didn't land.
                proposal.status = ProposalStatus::Queued;
                env.storage()
                    .persistent()
                    .set(&DataKey::Proposal(proposal_id), &proposal);

                emit_proposal_exec_failed(&env, proposal_id, 8u32);
                Err(err)
            }
        }
    }

    /// Hands the registry admin role to this governance contract.
    ///
    /// Requires authorization from `current_admin`. When invoked, this governance
    /// contract calls `registry.transfer_admin(&current_admin, &governance_address)`,
    /// satisfying the dual-authorization requirement where both `current_admin` and
    /// `new_admin` (this contract) must authorize the handover.
    pub fn accept_admin(
        env: Env,
        current_admin: Address,
        registry: Address,
    ) -> Result<(), GovernanceError> {
        current_admin.require_auth();

        let governance_addr = env.current_contract_address();
        let client = KeeperRegistryClient::new(&env, &registry);

        if matches!(
            client.try_transfer_admin(&current_admin, &governance_addr),
            Ok(Ok(()))
        ) {
            emit_admin_migrated(&env, &current_admin, &governance_addr, &registry);
            Ok(())
        } else {
            Err(GovernanceError::RegistryCallFailed)
        }
    }

    fn dispatch_registry_call(
        env: &Env,
        registry_addr: &Address,
        action: &GovernableAction,
    ) -> Result<(), GovernanceError> {
        let client = KeeperRegistryClient::new(env, registry_addr);
        let caller = env.current_contract_address();

        let success = match action {
            GovernableAction::SetFeeBps(new_bps) => {
                matches!(client.try_set_fee_bps(&caller, new_bps), Ok(Ok(())))
            }
            GovernableAction::SetMinReward(min_reward) => {
                matches!(client.try_set_min_reward(&caller, min_reward), Ok(Ok(())))
            }
            GovernableAction::SetReputationFloor(floor_bps) => {
                matches!(client.try_set_reputation_floor(&caller, floor_bps), Ok(Ok(())))
            }
            GovernableAction::Pause => {
                matches!(client.try_pause(&caller), Ok(Ok(())))
            }
            GovernableAction::Unpause => {
                matches!(client.try_unpause(&caller), Ok(Ok(())))
            }
        };


        if success {
            Ok(())
        } else {
            Err(GovernanceError::RegistryCallFailed)
        }
    }
}

#[cfg(test)]
mod test;
