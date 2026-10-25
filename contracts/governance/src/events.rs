//! Governance contract events.
//!
//! Every event uses a two-symbol topic pair `(verb, noun)` where noun is `"gov"`,
//! mirroring `contracts/keeper-registry/src/events.rs` and `contracts/treasury/src/events.rs`.
//! This ensures off-chain indexers and observer bots can subscribe to and reconstruct
//! full proposal lifecycles purely from the event stream.

use soroban_sdk::{symbol_short, Address, Env, Symbol};

/// Emitted when a new proposal is submitted.
pub fn emit_proposal_created(
    e: &Env,
    proposal_id: u64,
    proposer: &Address,
    eta: u64,
) {
    e.events().publish(
        (symbol_short!("proposed"), symbol_short!("gov")),
        (proposal_id, proposer.clone(), eta),
    );
}

/// Emitted when an individual vote is cast on a proposal.
///
/// Transparency rationale: Individual votes (voter address, support, and voting power)
/// are public on-chain to provide full cryptographic verifiability of tallies, enable
/// stakeholder accountability, and support per-voter activity feeds.
pub fn emit_vote_cast(
    e: &Env,
    proposal_id: u64,
    voter: &Address,
    support: u32,
    voting_power: i128,
) {
    e.events().publish(
        (symbol_short!("vcast"), symbol_short!("gov")),
        (proposal_id, voter.clone(), support, voting_power),
    );
}

/// Emitted when a proposal passes quorum and threshold evaluation.
pub fn emit_proposal_passed(
    e: &Env,
    proposal_id: u64,
    votes_for: i128,
    votes_against: i128,
    votes_abstain: i128,
) {
    e.events().publish(
        (symbol_short!("passed"), symbol_short!("gov")),
        (proposal_id, votes_for, votes_against, votes_abstain),
    );
}

/// Emitted when a proposal fails quorum or majority threshold.
pub fn emit_proposal_defeated(
    e: &Env,
    proposal_id: u64,
    votes_for: i128,
    votes_against: i128,
    votes_abstain: i128,
) {
    e.events().publish(
        (symbol_short!("defeat"), symbol_short!("gov")),
        (proposal_id, votes_for, votes_against, votes_abstain),
    );
}

/// Emitted when a proposal enters the timelock queue with a target ETA.
pub fn emit_proposal_queued(e: &Env, proposal_id: u64, eta: u64) {
    e.events().publish(
        (symbol_short!("queued"), symbol_short!("gov")),
        (proposal_id, eta),
    );
}

/// Emitted when a passed, timelocked proposal successfully executes against the registry.
pub fn emit_proposal_executed(e: &Env, proposal_id: u64) {
    e.events().publish(
        (symbol_short!("executed"), symbol_short!("gov")),
        (proposal_id,),
    );
}

/// Emitted when cross-contract execution against the registry fails, leaving the proposal in a recoverable state.
pub fn emit_proposal_exec_failed(e: &Env, proposal_id: u64, error_code: u32) {
    e.events().publish(
        (symbol_short!("exfail"), symbol_short!("gov")),
        (proposal_id, error_code),
    );
}

/// Emitted when an open or queued proposal is cancelled by its proposer or admin.
pub fn emit_proposal_cancelled(e: &Env, proposal_id: u64) {
    e.events().publish(
        (symbol_short!("cancel"), symbol_short!("gov")),
        (proposal_id,),
    );
}

/// Emitted when admin migration to the governance contract completes.
pub fn emit_admin_migrated(
    e: &Env,
    current_admin: &Address,
    governance_addr: &Address,
    registry: &Address,
) {
    e.events().publish(
        (
            Symbol::new(e, "admin_migrated"),
            current_admin.clone(),
            governance_addr.clone(),
        ),
        registry.clone(),
    );
}
