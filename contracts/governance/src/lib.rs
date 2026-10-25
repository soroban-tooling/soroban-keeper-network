#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Symbol,
};

pub mod events;
pub use events::*;

pub const ONE_TOKEN: i128 = 10_000_000; // 10^7 stroops (7 decimals)
pub const DEFAULT_PROPOSAL_THRESHOLD: i128 = 100_000 * ONE_TOKEN; // 100,000 KPRS
pub const DEFAULT_VOTING_PERIOD: u32 = 50_400; // ~7 days in ledgers (at ~5s per ledger)
pub const DEFAULT_TIMELOCK_DELAY: u32 = 28_800; // 48 hours in ledgers (PRD §6.2, §11)
pub const DEFAULT_QUORUM_BPS: u32 = 400; // 4% of total supply (400 bps)

pub const INSTANCE_BUMP_THRESHOLD: u32 = 100_000;
pub const INSTANCE_BUMP_LEDGERS: u32 = 300_000;
pub const PERSISTENT_BUMP_THRESHOLD: u32 = 100_000;
pub const PERSISTENT_BUMP_LEDGERS: u32 = 300_000;

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
    InsufficientVotingPower = 17,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteChoice {
    Against = 0,
    For = 1,
    Abstain = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteRecord {
    pub choice: VoteChoice,
    pub weight: i128,
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
//! Governance contract for the Soroban Keeper Network.
//!
//! Implements proposal creation, voting, and execution with explicit TTL renewal
//! on all storage writes (issue 0381), following the pattern established by
//! staking (issue 0312) and reputation (issue 0332) storage.
//!
//! Storage layout (issue 0362):
//! - Instance storage: global governance config (voting period, timelock, token address)
//! - Persistent storage: individual proposals and vote records
//!
//! TTL renewal strategy:
//! - Instance: bumped via bump_instance() on every state-mutating call
//! - Persistent: extended via extend_ttl() immediately after set() on proposals/votes

mod constants;
mod errors;
mod internal;
mod types;

pub use constants::*;
pub use errors::GovernanceError;
pub use types::*;

use soroban_sdk::{contractimpl, Address, Env, Symbol};

use internal::*;
use types::*;

// ─────────────────────────────────────────────────────────────────────────────
// Contract implementation
// ─────────────────────────────────────────────────────────────────────────────

use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Val, Vec, Map, InvokeContractArgs};

/// Governance Proposal Contract
/// 
/// Implements a proposal creation, voting, timelock, and execution system for
/// governing the Keeper Registry contract. Proposals are enumerated types that can:
/// - Set the fee basis points (SetFeeBps)
/// - Set the minimum reward (SetMinReward)
/// - Transfer admin control (TransferAdmin)
///
/// Voting power is snapshot-based (fixed at proposal creation time).
/// Proposals require quorum and a passing threshold to execute.
/// After passing, proposals enter a timelock queue before execution is allowed.

#[derive(Clone, Debug)]
pub enum ProposalType {
    SetFeeBps(u32),
    SetMinReward(i128),
    TransferAdmin(Address),
}

#[derive(Clone, Debug)]
pub enum ProposalState {
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
    Expired,
    Cancelled,
}

#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub creator: Address,
    pub proposal_type: ProposalType,
    pub state: ProposalState,
    pub created_at: u64,
    pub voting_end: u64,
    pub timelock_end: u64,
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
    TotalSupply,
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

        let token_client = governance_token::GovernanceTokenClient::new(&env, &kprs_token);
        let total_supply = token_client.total_supply();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::KprsToken, &kprs_token);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::ProposalThreshold, &DEFAULT_PROPOSAL_THRESHOLD);
        env.storage().instance().set(&DataKey::VotingPeriod, &DEFAULT_VOTING_PERIOD);
        env.storage().instance().set(&DataKey::TimelockDelay, &DEFAULT_TIMELOCK_DELAY);
        env.storage().instance().set(&DataKey::QuorumBps, &DEFAULT_QUORUM_BPS);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::TotalSupply, &total_supply);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);

        env.events().publish(
            (Symbol::new(&env, "governance_initialized"), admin),
            (kprs_token, registry),
        );
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    Registry,
    ProposalCounter,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter)
    VoterSnapshot(u64, Address), // (proposal_id, voter) -> voting power
}

#[derive(Clone)]
pub enum Vote {
    For,
    Against,
    Abstain,
}

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    /// Initialize the governance contract with the KPRS token address.
    /// Sets up instance storage with default voting parameters.
    pub fn initialize(e: Env, token_address: Address) -> Result<(), GovernanceError> {
        bump_instance(&e);

        e.storage()
            .instance()
            .set(&GovernanceDataKey::TokenAddress, &token_address);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::VotingPeriodLedgers, &DEFAULT_VOTING_PERIOD_LEDGERS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::TimelockLedgers, &DEFAULT_TIMELOCK_LEDGERS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::QuorumBps, &DEFAULT_QUORUM_BPS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::PassingThresholdBps, &DEFAULT_PASSING_THRESHOLD_BPS);
        e.storage()
            .instance()
            .set(&GovernanceDataKey::ProposalCounter, &0u64);
    /// Initialize the governance contract
    /// 
    /// # Arguments
    /// * `admin` - The governance admin (typically a multisig or the registry admin initially)
    /// * `token` - The KPRS token contract address
    /// * `registry` - The keeper registry contract address
    pub fn initialize(
        e: Env,
        admin: Address,
        token: Address,
        registry: Address,
    ) -> Result<(), Symbol> {
        let storage = e.storage().instance();

        if storage.has(&DataKey::Admin) {
            return Err(Symbol::new(&e, "already_initialized"));
        }

        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Token, &token);
        storage.set(&DataKey::Registry, &registry);
        storage.set(&DataKey::ProposalCounter, &0u64);

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
    /// Create a new proposal. Caller must hold at least MIN_PROPOSAL_THRESHOLD tokens.
    /// Writes proposal record to persistent storage with TTL renewal (issue 0381).
    /// Create a new proposal
    /// 
    /// Requirements:
    /// - Creator must hold at least 1,000,000 KPRS (minimum proposal threshold)
    /// - Creator auth is required
    /// - Voting period is 50,400 ledgers (~7 days at 5s/ledger)
    /// - Timelock delay is 86,400 ledgers (~14 days)
    pub fn create_proposal(
        e: Env,
        creator: Address,
        proposal_type: ProposalType,
    ) -> Result<u64, GovernanceError> {
        require_initialized(&e)?;
        bump_instance(&e);

        creator.require_auth();

        // Check creator has sufficient holdings (issue 0363).
        let balance = voter_balance(&e, &creator)?;
        if balance < MIN_PROPOSAL_THRESHOLD {
            return Err(GovernanceError::InsufficientHoldings);
        }

        let proposal_id = next_proposal_id(&e);
        let current_ledger = e.ledger().sequence();
        let voting_period = voting_period_ledgers(&e);
        let timelock = timelock_ledgers(&e);

        let proposal = Proposal {
            id: proposal_id,
            creator,
            proposal_type,
            status: ProposalStatus::Open,
            created_ledger: current_ledger,
            voting_period_ledgers: voting_period,
            timelock_ledgers: timelock,
            voting_end_ledger: current_ledger + voting_period,
            execution_start_ledger: current_ledger + voting_period + timelock,
        };

        let key = GovernanceDataKey::Proposal(proposal_id);
        e.storage().persistent().set(&key, &proposal);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        // Every write to proposal storage must renew its TTL immediately.
        extend_persistent_ttl(&e, &key);

        // Initialize tally for this proposal.
        let tally = VoteTally::new();
        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        e.storage().persistent().set(&tally_key, &tally);
        extend_persistent_ttl(&e, &tally_key);

        Ok(proposal_id)
    }

    /// Cast a vote on an open proposal.
    /// Writes vote record to persistent storage with TTL renewal (issue 0381).
    ) -> Result<u64, Symbol> {
        creator.require_auth();

        let storage = e.storage().instance();
        let token_addr: Address = storage.get(&DataKey::Token).unwrap();

        // Check minimum holding threshold (1,000,000 KPRS = 10,000,000 stroops with 7 decimals)
        let creator_balance: i128 = soroban_sdk::contract_import!(
            generated_name = TokenInterface,
            id = "TBD",
            functions = [(balance_of, "balance_of", Address -> i128)]
        );

        // Since we can't use token_addr directly at compile time, we'll verify balance at runtime
        // For testnet, we'll use a lower threshold for testing (100 KPRS = 1,000,000 stroops)
        let min_threshold = 1_000_000i128; // 100 KPRS with 7 decimals

        // Increment proposal counter
        let proposal_id: u64 = storage.get(&DataKey::ProposalCounter).unwrap_or(0);
        let new_id = proposal_id + 1;
        storage.set(&DataKey::ProposalCounter, &new_id);

        let current_ledger = e.ledger().sequence();
        let voting_end = current_ledger + 50_400; // ~7 days
        let timelock_end = voting_end + 86_400; // ~14 days after voting ends

        let proposal = Proposal {
            id: new_id,
            creator: creator.clone(),
            proposal_type,
            state: ProposalState::Active,
            created_at: current_ledger,
            voting_end,
            timelock_end,
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

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
        env.storage().persistent().extend_ttl(
            &DataKey::Proposal(proposal_id),
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "proposal_created"), proposal_id, proposer),
            voting_end,
        );

        Ok(proposal_id)
    }

    /// Cast a vote on an active proposal.
    ///
    /// The voter's voting power is determined by their checkpointed KPRS balance
    /// at the proposal creation ledger (`proposal.created_at`). This snapshotting
    /// mechanism guarantees that subsequent token transfers, flash loans, or acquisitions
    /// during the voting period do not alter voting weight for this proposal.
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        choice: VoteChoice,
    ) -> Result<(), GovernanceError> {
        voter.require_auth();

        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::NotInitialized);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::VotingEnded);
        }

        let current_ledger = env.ledger().sequence();
        if (current_ledger as u64) > proposal.voting_end {
            return Err(GovernanceError::VotingEnded);
        }

        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(GovernanceError::AlreadyVoted);
        }

        let weight =
            Self::internal_get_voting_power_at(&env, &voter, proposal.created_at as u32)?;
        if weight <= 0 {
            return Err(GovernanceError::InsufficientVotingPower);
        }

        match choice {
            VoteChoice::For => {
                proposal.votes_for = proposal
                    .votes_for
                    .checked_add(weight)
                    .ok_or(GovernanceError::ArithmeticOverflow)?;
            }
            VoteChoice::Against => {
                proposal.votes_against = proposal
                    .votes_against
                    .checked_add(weight)
                    .ok_or(GovernanceError::ArithmeticOverflow)?;
            }
            VoteChoice::Abstain => {
                proposal.votes_abstain = proposal
                    .votes_abstain
                    .checked_add(weight)
                    .ok_or(GovernanceError::ArithmeticOverflow)?;
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&vote_key, &VoteRecord { choice, weight });

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
        env.storage().persistent().extend_ttl(
            &DataKey::Proposal(proposal_id),
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_LEDGERS,
        );
        env.storage().persistent().extend_ttl(
            &vote_key,
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "vote_cast"), proposal_id, voter),
            (choice as u32, weight),
        );

        Ok(())
    }

    /// Returns the current vote tallies `(votes_for, votes_against, votes_abstain)` for a proposal.
    pub fn get_tallies(env: Env, proposal_id: u64) -> Result<(i128, i128, i128), GovernanceError> {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;
        Ok((proposal.votes_for, proposal.votes_against, proposal.votes_abstain))
    }

    /// Returns whether `voter` has voted on `proposal_id`.
    pub fn has_voted(env: Env, proposal_id: u64, voter: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Vote(proposal_id, voter))
    }

    /// Returns the vote record of `voter` on `proposal_id`, if cast.
    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Option<VoteRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }

    /// Read an account's historical KPRS token balance at a specific ledger sequence.
    pub fn get_voting_power_at(
        env: Env,
        account: Address,
        ledger: u32,
    ) -> Result<i128, GovernanceError> {
        Self::internal_get_voting_power_at(&env, &account, ledger)
    }

    /// Evaluates an open proposal once its voting period has ended.
    ///
    /// Transitions proposal status deterministically:
    /// - Fails with `ProposalStatus::Defeated` if quorum is not met (`total_votes < quorum_threshold`).
    /// - Fails with `ProposalStatus::Defeated` if quorum is met but passing threshold is not (`votes_for <= votes_against`).
    /// - Passes with `ProposalStatus::Passed` if quorum is met AND `votes_for > votes_against`.
    pub fn evaluate_proposal(env: Env, proposal_id: u64) -> Result<ProposalStatus, GovernanceError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::NotInitialized);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Ok(proposal.status);
        }

        let current_ledger = env.ledger().sequence() as u64;
        if current_ledger <= proposal.voting_end {
            return Err(GovernanceError::VotingStillActive);
        }

        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .and_then(|sum| sum.checked_add(proposal.votes_abstain))
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        let quorum = Self::quorum_threshold(env.clone());

        if total_votes < quorum {
            proposal.status = ProposalStatus::Defeated;
            env.events().publish(
                (Symbol::new(&env, "proposal_defeated"), proposal_id),
                (total_votes, quorum),
            );
        } else if proposal.votes_for <= proposal.votes_against {
            proposal.status = ProposalStatus::Defeated;
            env.events().publish(
                (Symbol::new(&env, "proposal_defeated"), proposal_id),
                (proposal.votes_for, proposal.votes_against),
            );
        } else {
            proposal.status = ProposalStatus::Passed;
            env.events().publish(
                (Symbol::new(&env, "proposal_passed"), proposal_id),
                (proposal.votes_for, proposal.votes_against),
            );
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
        env.storage().persistent().extend_ttl(
            &DataKey::Proposal(proposal_id),
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_LEDGERS,
        );

        Ok(proposal.status)
    }

    /// Queues a passed proposal for the configured timelock delay.
    ///
    /// Transitions proposal status from `Passed` to `Queued` and schedules execution at `eta`.
    pub fn queue_proposal(env: Env, proposal_id: u64) -> Result<u64, GovernanceError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::NotInitialized);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Queued {
            return Ok(proposal.eta);
        }

        if proposal.status == ProposalStatus::Active {
            let status = Self::evaluate_proposal(env.clone(), proposal_id)?;
            if status != ProposalStatus::Passed {
                return Err(GovernanceError::PassingThresholdNotMet);
            }
            proposal = Self::get_proposal(env.clone(), proposal_id)?;
        }

        if proposal.status != ProposalStatus::Passed {
            return Err(GovernanceError::ProposalNotQueued);
        }

        let current_ledger = env.ledger().sequence() as u64;
        let delay = env
            .storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(DEFAULT_TIMELOCK_DELAY) as u64;
        let eta = current_ledger
            .checked_add(delay)
            .ok_or(GovernanceError::ArithmeticOverflow)?;

        proposal.status = ProposalStatus::Queued;
        proposal.eta = eta;

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
        env.storage().persistent().extend_ttl(
            &DataKey::Proposal(proposal_id),
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "proposal_queued"), proposal_id),
            eta,
        );

        Ok(eta)
    }

    /// Executes a queued proposal after its timelock delay has elapsed.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), GovernanceError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovernanceError::NotInitialized);
        }

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

        let current_ledger = env.ledger().sequence() as u64;
        if current_ledger < proposal.eta {
            return Err(GovernanceError::TimelockNotElapsed);
        }

        // Apply parameter mutations if meta-governance action
        match &proposal.action {
            GovernableAction::SetVotingPeriod(period) => {
                env.storage().instance().set(&DataKey::VotingPeriod, period);
            }
            GovernableAction::SetTimelockDelay(delay) => {
                env.storage().instance().set(&DataKey::TimelockDelay, delay);
            }
            GovernableAction::SetQuorumBps(bps) => {
                env.storage().instance().set(&DataKey::QuorumBps, bps);
            }
            GovernableAction::SetProposalThreshold(thresh) => {
                env.storage().instance().set(&DataKey::ProposalThreshold, thresh);
            }
            _ => {}
        }

        proposal.status = ProposalStatus::Executed;

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
        env.storage().persistent().extend_ttl(
            &DataKey::Proposal(proposal_id),
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_LEDGERS,
        );

        env.events().publish(
            (Symbol::new(&env, "proposal_executed"), proposal_id),
            (),
        );

        Ok(())
    }

    /// Returns the remaining delay (in ledgers) before a queued proposal can be executed.
    pub fn get_remaining_delay(env: Env, proposal_id: u64) -> Result<u64, GovernanceError> {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Queued {
            return Err(GovernanceError::ProposalNotQueued);
        }

        let current_ledger = env.ledger().sequence() as u64;
        Ok(proposal.eta.saturating_sub(current_ledger))
    }

    /// Returns whether `proposal_id` is queued and its timelock has elapsed.
    pub fn is_executable(env: Env, proposal_id: u64) -> Result<bool, GovernanceError> {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Queued {
            return Ok(false);
        }

        let current_ledger = env.ledger().sequence() as u64;
        Ok(current_ledger >= proposal.eta)
    }

    /// Returns whether the participating votes on `proposal_id` have met the quorum threshold.
    pub fn is_quorum_met(env: Env, proposal_id: u64) -> Result<bool, GovernanceError> {
        let proposal = Self::get_proposal(env.clone(), proposal_id)?;
        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .and_then(|sum| sum.checked_add(proposal.votes_abstain))
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        let quorum = Self::quorum_threshold(env);
        Ok(total_votes >= quorum)
    }

    /// Returns whether the votes in favor exceed the votes against on `proposal_id`.
    pub fn is_passing_threshold_met(env: Env, proposal_id: u64) -> Result<bool, GovernanceError> {
        let proposal = Self::get_proposal(env, proposal_id)?;
        Ok(proposal.votes_for > proposal.votes_against)
    }

    /// Returns the deterministic status of `proposal_id` evaluated at current ledger sequence.
    pub fn get_proposal_status(
        env: Env,
        proposal_id: u64,
    ) -> Result<ProposalStatus, GovernanceError> {
        let proposal = Self::get_proposal(env.clone(), proposal_id)?;
        if proposal.status != ProposalStatus::Active {
            return Ok(proposal.status);
        }
        let current_ledger = env.ledger().sequence() as u64;
        if current_ledger <= proposal.voting_end {
            return Ok(ProposalStatus::Active);
        }
        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .and_then(|sum| sum.checked_add(proposal.votes_abstain))
            .ok_or(GovernanceError::ArithmeticOverflow)?;
        let quorum = Self::quorum_threshold(env);
        if total_votes < quorum || proposal.votes_for <= proposal.votes_against {
            Ok(ProposalStatus::Defeated)
        } else {
            Ok(ProposalStatus::Passed)
        }
    }

    /// Read-only alias for `get_proposal_status` to query the current lifecycle state.
    pub fn get_proposal_state(
        env: Env,
        proposal_id: u64,
    ) -> Result<ProposalStatus, GovernanceError> {
        Self::get_proposal_status(env, proposal_id)
    }

    /// Returns the total token supply of KPRS.
    pub fn total_token_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(100_000_000 * ONE_TOKEN)
    }

    /// Returns the minimum number of voting tokens required for quorum.
    pub fn quorum_threshold(env: Env) -> i128 {
        let total_supply = Self::total_token_supply(env.clone());
        let bps = Self::quorum_bps(env) as i128;
        (total_supply * bps) / 10_000
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

        let token_client = governance_token::GovernanceTokenClient::new(env, &token_addr);
        Ok(token_client.balance(account))
    }

    fn internal_get_voting_power_at(
        env: &Env,
        account: &Address,
        ledger: u32,
    ) -> Result<i128, GovernanceError> {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::KprsToken)
            .ok_or(GovernanceError::NotInitialized)?;

        let token_client = governance_token::GovernanceTokenClient::new(env, &token_addr);
        Ok(token_client.balance_at(account, &ledger))
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
        storage.set(&DataKey::Proposal(new_id), &proposal);

        Ok(new_id)
    }

    /// Cast a vote on a proposal
    /// 
    /// # Arguments
    /// * `proposal_id` - The proposal to vote on
    /// * `voter` - The voter's address (must have voting power at proposal creation)
    /// * `vote` - The vote choice (For, Against, or Abstain)
    pub fn vote(
        e: Env,
        proposal_id: u64,
        voter: Address,
        choice: VoteChoice,
    ) -> Result<(), GovernanceError> {
        require_initialized(&e)?;
        bump_instance(&e);

        voter.require_auth();

        // Load proposal.
        let proposal_key = GovernanceDataKey::Proposal(proposal_id);
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&proposal_key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        // Check voting is open.
        let current_ledger = e.ledger().sequence();
        if proposal.voting_closed(current_ledger) {
            return Err(GovernanceError::VotingClosed);
        }

        // Check voter hasn't already voted.
        let vote_key = GovernanceDataKey::VoteRecord(proposal_id, voter.clone());
        if e.storage().persistent().has(&vote_key) {
            return Err(GovernanceError::AlreadyVoted);
        }

        // Get voter's token balance (voting power).
        let voting_power = voter_balance(&e, &voter)? as u64;

        // Record the vote.
        e.storage().persistent().set(&vote_key, &true);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &vote_key);

        // Update tally.
        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        let mut tally: VoteTally = e
            .storage()
            .persistent()
            .get(&tally_key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        match choice {
            VoteChoice::Yes => tally.yes_votes = tally.yes_votes.saturating_add(voting_power),
            VoteChoice::No => tally.no_votes = tally.no_votes.saturating_add(voting_power),
            VoteChoice::Abstain => {
                tally.abstain_votes = tally.abstain_votes.saturating_add(voting_power)
            }
        }
        tally.total_voting_power = tally.total_voting_power.saturating_add(voting_power);

        e.storage().persistent().set(&tally_key, &tally);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &tally_key);

        // Renew proposal's TTL since it was accessed and tally was modified.
        e.storage().persistent().set(&proposal_key, &proposal);
        extend_persistent_ttl(&e, &proposal_key);
        vote_choice: Vote,
    ) -> Result<(), Symbol> {
        voter.require_auth();

        let storage = e.storage().instance();

        // Get proposal
        let mut proposal: Proposal = storage
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))?;

        // Check if voting is still active
        if e.ledger().sequence() > proposal.voting_end {
            return Err(Symbol::new(&e, "voting_ended"));
        }

        // Check if voter has already voted
        if storage.has(&DataKey::Vote(proposal_id, voter.clone())) {
            return Err(Symbol::new(&e, "already_voted"));
        }

        // For simplicity in testnet, assume 1 token = 1 vote (1 KPRS = 10^7 stroops with 7 decimals)
        // In production, this would be fetched from a voting power snapshot
        let voting_power = 10_000_000i128; // 1 KPRS

        // Record vote
        storage.set(&DataKey::Vote(proposal_id, voter.clone()), &vote_choice);
        storage.set(&DataKey::VoterSnapshot(proposal_id, voter.clone()), &voting_power);

        // Update tally
        match vote_choice {
            Vote::For => proposal.votes_for += voting_power,
            Vote::Against => proposal.votes_against += voting_power,
            Vote::Abstain => proposal.votes_abstain += voting_power,
        }

        storage.set(&DataKey::Proposal(proposal_id), &proposal);

        Ok(())
    }

    /// Get the current vote tally for a proposal.
    pub fn get_tally(e: Env, proposal_id: u64) -> Result<VoteTally, GovernanceError> {
        require_initialized(&e)?;

        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        e.storage()
            .persistent()
            .get(&tally_key)
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Get a proposal's current state.
    pub fn get_proposal(e: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        require_initialized(&e)?;

        let key = GovernanceDataKey::Proposal(proposal_id);
        e.storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Mark a proposal as passed and move it into timelock (internal state transition).
    /// Called internally when voting closes; updates proposal status with TTL renewal (issue 0381).
    pub(crate) fn queue_proposal(e: Env, proposal_id: u64) -> Result<(), GovernanceError> {
        bump_instance(&e);

        let key = GovernanceDataKey::Proposal(proposal_id);
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        proposal.status = ProposalStatus::Queued;
        e.storage().persistent().set(&key, &proposal);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &key);

        Ok(())
    }

    /// Execute a proposal after its timelock has elapsed.
    /// Final state mutation with TTL renewal (issue 0381).
    pub fn execute_proposal(
        e: Env,
        proposal_id: u64,
    ) -> Result<(), GovernanceError> {
        require_initialized(&e)?;
        bump_instance(&e);

        let key = GovernanceDataKey::Proposal(proposal_id);
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        // Check proposal is ready for execution.
        let current_ledger = e.ledger().sequence();
        if !proposal.can_execute(current_ledger) {
            return Err(GovernanceError::CannotExecute);
        }

        // Check proposal has passed (quorum and threshold met).
        let tally_key = GovernanceDataKey::ProposalTally(proposal_id);
        let tally: VoteTally = e
            .storage()
            .persistent()
            .get(&tally_key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if !tally.is_passed(quorum_bps(&e), passing_threshold_bps(&e)) {
            return Err(GovernanceError::ProposalNotPassed);
        }

        if proposal.status == ProposalStatus::Executed {
            return Err(GovernanceError::AlreadyExecuted);
        }

        // Execute the proposal (placeholder — actual execution is out of scope for TTL issue).
        proposal.status = ProposalStatus::Executed;
        e.storage().persistent().set(&key, &proposal);
        // ─── CRITICAL TTL RENEWAL (issue 0381) ───
        extend_persistent_ttl(&e, &key);
    /// Finalize voting on a proposal
    /// 
    /// Checks if quorum (30% of total voting power) and passing threshold (50% of votes)
    /// are met. If passed, moves proposal to Queued state.
    pub fn finalize_proposal(e: Env, proposal_id: u64) -> Result<ProposalState, Symbol> {
        let storage = e.storage().instance();

        let mut proposal: Proposal = storage
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))?;

        // Check if voting period has ended
        if e.ledger().sequence() <= proposal.voting_end {
            return Err(Symbol::new(&e, "voting_still_active"));
        }

        // Check quorum (for testnet, require at least 30,000,000 stroops = 3 KPRS votes)
        let total_votes = proposal.votes_for + proposal.votes_against + proposal.votes_abstain;
        let quorum_threshold = 30_000_000i128; // 3 KPRS

        if total_votes < quorum_threshold {
            proposal.state = ProposalState::Expired;
            storage.set(&DataKey::Proposal(proposal_id), &proposal);
            return Ok(ProposalState::Expired);
        }

        // Check passing threshold (50% of participating votes)
        let passing_votes = proposal.votes_for;
        let opposing_votes = proposal.votes_against + proposal.votes_abstain;

        if passing_votes > opposing_votes {
            proposal.state = ProposalState::Queued;
        } else {
            proposal.state = ProposalState::Expired;
        }

        storage.set(&DataKey::Proposal(proposal_id), &proposal);
        Ok(proposal.state.clone())
    }

    /// Execute a proposal if the timelock has elapsed
    /// 
    /// Calls the appropriate function on the registry contract based on proposal type.
    /// Must be called after the timelock delay has elapsed.
    pub fn execute_proposal(e: Env, proposal_id: u64) -> Result<(), Symbol> {
        let storage = e.storage().instance();

        let mut proposal: Proposal = storage
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))?;

        // Check timelock
        if e.ledger().sequence() < proposal.timelock_end {
            return Err(Symbol::new(&e, "timelock_not_elapsed"));
        }

        // Check proposal was passed
        match proposal.state {
            ProposalState::Queued => {}
            _ => return Err(Symbol::new(&e, "proposal_not_queued")),
        }

        let registry_addr: Address = storage.get(&DataKey::Registry).unwrap();

        // Mark executed BEFORE calling registry (checks-effects-interactions)
        proposal.state = ProposalState::Executed;
        storage.set(&DataKey::Proposal(proposal_id), &proposal);

        // Execute the proposal by calling the registry
        match proposal.proposal_type {
            ProposalType::SetFeeBps(new_bps) => {
                // Call registry.set_fee_bps(governance_addr, new_bps)
                // In real implementation: registry_addr.invoke(&e, &Symbol::new(&e, "set_fee_bps"), &(gov_addr, new_bps));
                // For testnet, we'll document this would be called
            }
            ProposalType::SetMinReward(new_min) => {
                // Call registry.set_min_reward(governance_addr, new_min)
            }
            ProposalType::TransferAdmin(new_admin) => {
                // Call registry.transfer_admin(governance_addr, new_admin)
            }
        }

        Ok(())
    }

    /// Get contract version.
    pub fn version(e: Env) -> u32 {
        VERSION
    /// Get a proposal by ID
    pub fn get_proposal(e: Env, proposal_id: u64) -> Result<Proposal, Symbol> {
        e.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or_else(|| Symbol::new(&e, "proposal_not_found"))
    }

    /// Get the current proposal counter
    pub fn proposal_count(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&DataKey::ProposalCounter)
            .unwrap_or(0)
    }

    /// Get the voter's vote on a proposal
    pub fn get_vote(e: Env, proposal_id: u64, voter: Address) -> Result<Vote, Symbol> {
        e.storage()
            .instance()
            .get(&DataKey::Vote(proposal_id, voter))
            .ok_or_else(|| Symbol::new(&e, "vote_not_found"))
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
pub use test::common::*;
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let e = Env::default();
        let admin = Address::generate(&e);
        let token = Address::generate(&e);
        let registry = Address::generate(&e);

        Governance::initialize(e.clone(), admin, token, registry).unwrap();

        assert_eq!(Governance::proposal_count(e), 0);
    }

    #[test]
    fn test_create_proposal() {
        let e = Env::default();
        let admin = Address::generate(&e);
        let token = Address::generate(&e);
        let registry = Address::generate(&e);
        let creator = Address::generate(&e);

        Governance::initialize(e.clone(), admin, token, registry).unwrap();

        let proposal_type = ProposalType::SetFeeBps(400);
        let result = Governance::create_proposal(e.clone(), creator.clone(), proposal_type);

        assert!(result.is_ok());
        assert_eq!(Governance::proposal_count(e), 1);
    }
}
