#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env, Symbol,
};

/// Semantic version of the governance contract logic.
pub const VERSION: u32 = 1;

#[contractclient(name = "KeeperRegistryClient")]
pub trait IKeeperRegistry {
    fn set_fee_bps(env: Env, admin: Address, new_bps: u32);
    fn set_min_reward(env: Env, admin: Address, min_reward: i128);
    fn set_reputation_floor(env: Env, admin: Address, floor_bps: u32);
    fn pause(env: Env, admin: Address);
    fn unpause(env: Env, admin: Address);
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
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct ProposalTally {
    pub for_votes: i128,
    pub against_votes: i128,
    pub abstain_votes: i128,
    pub total_votes: i128,
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
    InvalidVotingPower = 9,
    ArithmeticOverflow = 10,
    InvalidQuorumBps = 11,
    InvalidVoteChoice = 12,
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

        env.events().publish(
            (symbol_short!("proposed"), proposer, proposal_id),
            eta,
        );

        Ok(proposal_id)
    }

    /// Retrieves a proposal by its unique ID.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)
    }

    /// Casts a vote on an active or queued proposal.
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: u32,
    ) -> Result<(), GovernanceError> {
        voter.require_auth();

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Queued && proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotQueued);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Vote(proposal_id, voter.clone()), &support);

        env.events().publish(
            (symbol_short!("vote_cast"), voter, proposal_id),
            support,
        );

        Ok(())
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
        if !is_timelock_elapsed(now, proposal.eta) {
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
                env.events().publish(
                    (Symbol::new(&env, "proposal_executed"), proposal_id),
                    proposal_id,
                );
                Ok(())
            }
            Err(err) => {
                // If the underlying registry call failed, leave proposal in a recoverable
                // state (Queued), not silently marked executed when change didn't land.
                proposal.status = ProposalStatus::Queued;
                env.storage()
                    .persistent()
                    .set(&DataKey::Proposal(proposal_id), &proposal);

                env.events().publish(
                    (Symbol::new(&env, "proposal_exec_failed"), proposal_id),
                    proposal_id,
                );
                Err(err)
            }
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

// ─────────────────────────────────────────────────────────────────────────────
// Pure Arithmetic & Tallying Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Pure arithmetic function calculating proposal tallies from a sequence of (voting_power, choice) votes.
/// Choice: 0 = Against, 1 = For, 2 = Abstain.
/// Returns typed error on negative voting power, invalid choice, or arithmetic overflow.
pub fn calculate_tally(votes: &[(i128, u32)]) -> Result<ProposalTally, GovernanceError> {
    let mut for_votes = 0i128;
    let mut against_votes = 0i128;
    let mut abstain_votes = 0i128;
    let mut total_votes = 0i128;

    for &(power, choice) in votes {
        if power < 0 {
            return Err(GovernanceError::InvalidVotingPower);
        }
        match choice {
            0 => {
                against_votes = against_votes
                    .checked_add(power)
                    .ok_or(GovernanceError::ArithmeticOverflow)?;
            }
            1 => {
                for_votes = for_votes
                    .checked_add(power)
                    .ok_or(GovernanceError::ArithmeticOverflow)?;
            }
            2 => {
                abstain_votes = abstain_votes
                    .checked_add(power)
                    .ok_or(GovernanceError::ArithmeticOverflow)?;
            }
            _ => return Err(GovernanceError::InvalidVoteChoice),
        }
        total_votes = total_votes
            .checked_add(power)
            .ok_or(GovernanceError::ArithmeticOverflow)?;
    }

    Ok(ProposalTally {
        for_votes,
        against_votes,
        abstain_votes,
        total_votes,
    })
}

/// Computes required quorum threshold: (total_supply * quorum_bps) / 10_000.
/// Avoids intermediate overflow using quotient-remainder decomposition.
pub fn compute_quorum_threshold(
    total_supply: i128,
    quorum_bps: u32,
) -> Result<i128, GovernanceError> {
    if quorum_bps > 10_000 {
        return Err(GovernanceError::InvalidQuorumBps);
    }
    if total_supply < 0 {
        return Err(GovernanceError::InvalidVotingPower);
    }

    let quotient = total_supply / 10_000;
    let remainder = total_supply % 10_000;

    let part1 = quotient
        .checked_mul(quorum_bps as i128)
        .ok_or(GovernanceError::ArithmeticOverflow)?;
    let part2 = (remainder * (quorum_bps as i128)) / 10_000;

    part1
        .checked_add(part2)
        .ok_or(GovernanceError::ArithmeticOverflow)
}

/// Evaluates whether a proposal passed based on tally, total supply, and quorum bps.
/// Proposal passes iff total_votes >= quorum threshold AND for_votes > against_votes.
pub fn evaluate_proposal_outcome(
    tally: &ProposalTally,
    total_supply: i128,
    quorum_bps: u32,
) -> Result<bool, GovernanceError> {
    let quorum_required = compute_quorum_threshold(total_supply, quorum_bps)?;
    if tally.total_votes < quorum_required {
        return Ok(false);
    }
    Ok(tally.for_votes > tally.against_votes)
}

/// Computes execution ETA given proposal queuing timestamp and timelock delay.
/// Returns typed error on timestamp addition overflow.
pub fn compute_timelock_eta(queued_at: u64, delay: u64) -> Result<u64, GovernanceError> {
    queued_at
        .checked_add(delay)
        .ok_or(GovernanceError::ArithmeticOverflow)
}

/// Determines whether timelock delay has elapsed at `now` relative to `eta`.
/// Inclusive boundary: returns true if now >= eta.
pub fn is_timelock_elapsed(now: u64, eta: u64) -> bool {
    now >= eta
}

/// Calculates remaining timelock delay. Returns 0 if already elapsed or in the past.
pub fn remaining_timelock_delay(now: u64, eta: u64) -> u64 {
    if now < eta {
        eta - now
    } else {
        0
    }
}

#[cfg(test)]
mod test;
