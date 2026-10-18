#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Symbol,
};

pub const ONE_TOKEN: i128 = 10_000_000; // 10^7 stroops (7 decimals)
pub const DEFAULT_PROPOSAL_THRESHOLD: i128 = 100_000 * ONE_TOKEN; // 100,000 KPRS
pub const DEFAULT_VOTING_PERIOD: u32 = 50_400; // ~7 days in ledgers (at ~5s per ledger)
pub const DEFAULT_TIMELOCK_DELAY: u32 = 28_800; // 48 hours in ledgers (PRD §6.2, §11)
pub const DEFAULT_QUORUM_BPS: u32 = 400; // 4% of total supply (400 bps)

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum GovernanceError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InsufficientProposerBalance = 3,
    InvalidParameterValue = 4,
    ProposalNotFound = 5,
    VotingEnded = 6,
    VotingStillActive = 7,
    AlreadyVoted = 8,
    QuorumNotMet = 9,
    PassingThresholdNotMet = 10,
    TimelockNotElapsed = 11,
    ProposalAlreadyExecuted = 12,
    ProposalNotQueued = 13,
    RegistryCallFailed = 14,
    Unauthorized = 15,
    ArithmeticOverflow = 16,
}

/// Closed enumeration of governable actions supported by the network (PRD / Issue #488 & #491).
/// Arbitrary contract calls are explicitly rejected.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernableAction {
    // ── Registry Parameters ──
    SetFeeBps(u32),
    SetMinReward(i128),
    SetReputationFloor(u32),
    PauseRegistry,
    UnpauseRegistry,

    // ── Treasury Parameters ──
    AddTreasuryRecipient(Address, u32),
    RemoveTreasuryRecipient(Address),
    UpdateTreasuryShares(Address, u32),
    PauseTreasury,
    UnpauseTreasury,

    // ── Meta-Governance (Governance Contract itself) ──
    SetVotingPeriod(u32),
    SetTimelockDelay(u32),
    SetQuorumBps(u32),
    SetProposalThreshold(i128),

    // ── Contract Upgrades ──
    UpgradeRegistry(BytesN<32>),
    UpgradeTreasury(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Queued,
    Executed,
    Defeated,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action: GovernableAction,
    pub status: ProposalStatus,
    pub created_at: u64,
    pub voting_end: u64,
    pub eta: u64,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    KprsToken,
    Registry,
    Treasury,
    ProposalThreshold,
    VotingPeriod,
    TimelockDelay,
    QuorumBps,
    ProposalCount,
    Proposal(u64),
    Vote(u64, Address),
    VoterPower(u64, Address),
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the governance contract with its dependencies and default parameters.
    pub fn initialize(
        env: Env,
        admin: Address,
        kprs_token: Address,
        registry: Address,
    ) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::KprsToken, &kprs_token);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::ProposalThreshold, &DEFAULT_PROPOSAL_THRESHOLD);
        env.storage().instance().set(&DataKey::VotingPeriod, &DEFAULT_VOTING_PERIOD);
        env.storage().instance().set(&DataKey::TimelockDelay, &DEFAULT_TIMELOCK_DELAY);
        env.storage().instance().set(&DataKey::QuorumBps, &DEFAULT_QUORUM_BPS);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events().publish(
            (Symbol::new(&env, "governance_initialized"), admin),
            (kprs_token, registry),
        );

        Ok(())
    }

    /// Creates a proposal against the closed list of governable parameters.
    ///
    /// Requires authorization from `proposer` and verifies the proposer holds at least
    /// the minimum holding threshold (`ProposalThreshold`).
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        action: GovernableAction,
    ) -> Result<u64, GovernanceError> {
        proposer.require_auth();

        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::NotInitialized);
        }

        // Enforce the minimum-holding threshold
        let balance = Self::internal_get_voting_power(&env, &proposer)?;
        let threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(DEFAULT_PROPOSAL_THRESHOLD);

        if balance < threshold {
            return Err(GovernanceError::InsufficientProposerBalance);
        }

        // Validate the action within defined safe parameter bounds
        Self::internal_validate_action(&action)?;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count.checked_add(1).ok_or(GovernanceError::ArithmeticOverflow)?;

        let current_ledger = env.ledger().sequence();
        let voting_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(DEFAULT_VOTING_PERIOD);
        let voting_end = current_ledger.saturating_add(voting_period);

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            action: action.clone(),
            status: ProposalStatus::Active,
            created_at: current_ledger as u64,
            voting_end: voting_end as u64,
            eta: 0,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        env.events().publish(
            (Symbol::new(&env, "proposal_created"), proposal_id, proposer),
            voting_end,
        );

        Ok(proposal_id)
    }

    /// Read an account's KPRS token balance for governance checks.
    pub fn get_voting_power(env: Env, account: Address) -> Result<i128, GovernanceError> {
        Self::internal_get_voting_power(&env, &account)
    }

    /// Retrieves a proposal by its monotonic ID.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Returns the total number of proposals created.
    pub fn proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    /// Returns the configured proposal creation threshold.
    pub fn proposal_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(DEFAULT_PROPOSAL_THRESHOLD)
    }

    /// Returns the configured voting period in ledgers.
    pub fn voting_period(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(DEFAULT_VOTING_PERIOD)
    }

    /// Returns the configured timelock delay in ledgers.
    pub fn timelock_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(DEFAULT_TIMELOCK_DELAY)
    }

    /// Returns the configured quorum threshold in basis points.
    pub fn quorum_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::QuorumBps)
            .unwrap_or(DEFAULT_QUORUM_BPS)
    }

    /// Returns the governance admin address.
    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    /// Returns the KPRS token contract address.
    pub fn kprs_token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::KprsToken).unwrap()
    }

    /// Returns the registry contract address.
    pub fn registry(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Registry).unwrap()
    }

    /// Contract version identifier.
    pub fn version(_env: Env) -> u32 {
        1
    }
}

impl GovernanceContract {
    fn internal_get_voting_power(env: &Env, account: &Address) -> Result<i128, GovernanceError> {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::KprsToken)
            .ok_or(GovernanceError::NotInitialized)?;

        let token_client = token::Client::new(env, &token_addr);
        Ok(token_client.balance(account))
    }

    fn internal_validate_action(action: &GovernableAction) -> Result<(), GovernanceError> {
        match action {
            GovernableAction::SetFeeBps(bps) => {
                if *bps > 10_000 {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::SetMinReward(min) => {
                if *min < 0 {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::SetReputationFloor(floor) => {
                if *floor > 10_000 {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::AddTreasuryRecipient(_addr, shares_bps) => {
                if *shares_bps == 0 || *shares_bps > 10_000 {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::UpdateTreasuryShares(_addr, new_shares_bps) => {
                if *new_shares_bps == 0 || *new_shares_bps > 10_000 {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::SetVotingPeriod(period) => {
                // 14_400..=201_600 ledgers (1 to 14 days)
                if !(14_400..=201_600).contains(period) {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::SetTimelockDelay(delay) => {
                // 14_400..=86_400 ledgers (1 to 6 days)
                if !(14_400..=86_400).contains(delay) {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::SetQuorumBps(bps) => {
                // 100..=2_000 (1% to 20%)
                if !(100..=2_000).contains(bps) {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::SetProposalThreshold(thresh) => {
                if *thresh < 0 {
                    return Err(GovernanceError::InvalidParameterValue);
                }
            }
            GovernableAction::PauseRegistry
            | GovernableAction::UnpauseRegistry
            | GovernableAction::RemoveTreasuryRecipient(_)
            | GovernableAction::PauseTreasury
            | GovernableAction::UnpauseTreasury
            | GovernableAction::UpgradeRegistry(_)
            | GovernableAction::UpgradeTreasury(_) => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
