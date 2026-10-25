//! Ingestion for governance contract events (Issue #504).
//!
//! Handles `ProposalCreated`, `VoteCast`, `ProposalExecuted`,
//! `ProposalExecutionFailed`, and `ProposalCancelled`.
//!
//! Mirrors `ingest::admin` and `ingest::treasury`:
//! - Every event is stored idempotently with `ON CONFLICT (ledger, tx_index, event_index) DO NOTHING`.
//! - Provides strongly-typed query functions for the assembled proposal lifecycle view
//!   and per-voter activity history matching the issue 0229 feed pattern.

use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Apply one event to the governance tables.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;
    match &event.payload {
        EventPayload::ProposalCreated {
            proposal_id,
            proposer,
            eta,
            action,
        } => {
            client
                .execute(
                    "INSERT INTO governance_proposals
                       (ledger, tx_index, event_index, proposal_id, proposer, eta, action)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        proposer,
                        &(*eta as i64),
                        action,
                    ],
                )
                .await?;
        }

        EventPayload::VoteCast {
            proposal_id,
            voter,
            support,
            voting_power,
        } => {
            let vp_str = i128_to_sql(voting_power.unwrap_or(0));
            client
                .execute(
                    "INSERT INTO governance_votes
                       (ledger, tx_index, event_index, proposal_id, voter, support, voting_power)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        voter,
                        &(*support as i32),
                        &vp_str,
                    ],
                )
                .await?;
        }

        EventPayload::ProposalExecuted { proposal_id } => {
            client
                .execute(
                    "INSERT INTO governance_executions
                       (ledger, tx_index, event_index, proposal_id, status)
                     VALUES ($1, $2, $3, $4, 'executed')
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                    ],
                )
                .await?;
        }

        EventPayload::ProposalExecutionFailed { proposal_id } => {
            client
                .execute(
                    "INSERT INTO governance_executions
                       (ledger, tx_index, event_index, proposal_id, status)
                     VALUES ($1, $2, $3, $4, 'failed')
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                    ],
                )
                .await?;
        }

        EventPayload::ProposalCancelled { proposal_id } => {
            client
                .execute(
                    "INSERT INTO governance_executions
                       (ledger, tx_index, event_index, proposal_id, status)
                     VALUES ($1, $2, $3, $4, 'cancelled')
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                    ],
                )
                .await?;
        }

        _ => {}
    }

    Ok(())
}

/// Full lifecycle representation for a single governance proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposalLifecycle {
    pub proposal_id: u64,
    pub proposer: String,
    pub eta: u64,
    pub created_ledger: u32,
    pub total_votes: i64,
    pub votes_for: i64,
    pub votes_against: i64,
    pub votes_abstain: i64,
    pub voting_power_for: i128,
    pub voting_power_against: i128,
    pub voting_power_abstain: i128,
    pub status: String,
    pub execution_ledger: Option<u32>,
}

/// Query the assembled lifecycle of a proposal (acceptance criterion 2).
pub async fn proposal_lifecycle(
    client: &Client,
    proposal_id: u64,
) -> Result<Option<ProposalLifecycle>, IndexerError> {
    let row = client
        .query_opt(
            "SELECT
                proposal_id, proposer, eta, created_ledger,
                total_votes, votes_for, votes_against, votes_abstain,
                voting_power_for::text, voting_power_against::text, voting_power_abstain::text,
                status, execution_ledger
             FROM governance_proposal_lifecycle
             WHERE proposal_id = $1",
            &[&(proposal_id as i64)],
        )
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let p_id: i64 = row.get(0);
    let proposer: String = row.get(1);
    let eta: i64 = row.get(2);
    let created_ledger: i64 = row.get(3);
    let total_votes: i64 = row.get(4);
    let votes_for: i64 = row.get(5);
    let votes_against: i64 = row.get(6);
    let votes_abstain: i64 = row.get(7);
    let vp_for_str: String = row.get(8);
    let vp_against_str: String = row.get(9);
    let vp_abstain_str: String = row.get(10);
    let status: String = row.get(11);
    let exec_ledger: Option<i64> = row.get(12);

    Ok(Some(ProposalLifecycle {
        proposal_id: p_id as u64,
        proposer,
        eta: eta as u64,
        created_ledger: created_ledger as u32,
        total_votes,
        votes_for,
        votes_against,
        votes_abstain,
        voting_power_for: i128_from_sql(&vp_for_str)?,
        voting_power_against: i128_from_sql(&vp_against_str)?,
        voting_power_abstain: i128_from_sql(&vp_abstain_str)?,
        status,
        execution_ledger: exec_ledger.map(|l| l as u32),
    }))
}

/// A single entry in a voter's activity feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoterActivityItem {
    pub voter: String,
    pub proposal_id: u64,
    pub support: u32,
    pub voting_power: i128,
    pub ledger: u32,
    pub tx_index: u32,
    pub event_index: u32,
    pub proposer: Option<String>,
    pub eta: Option<u64>,
}

/// Query the chronological voting history for an address (acceptance criterion 3).
pub async fn voter_activity(
    client: &Client,
    voter: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<VoterActivityItem>, IndexerError> {
    let rows = client
        .query(
            "SELECT
                voter, proposal_id, support, voting_power::text,
                ledger, tx_index, event_index, proposer, eta
             FROM governance_voter_activity
             WHERE voter = $1
             ORDER BY ledger DESC, tx_index DESC, event_index DESC
             LIMIT $2 OFFSET $3",
            &[
                &voter,
                &(limit as i64),
                &(offset as i64),
            ],
        )
        .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let v: String = row.get(0);
        let proposal_id: i64 = row.get(1);
        let support: i32 = row.get(2);
        let vp_str: String = row.get(3);
        let ledger: i64 = row.get(4);
        let tx_index: i64 = row.get(5);
        let event_index: i64 = row.get(6);
        let proposer: Option<String> = row.get(7);
        let eta: Option<i64> = row.get(8);

        items.push(VoterActivityItem {
            voter: v,
            proposal_id: proposal_id as u64,
            support: support as u32,
            voting_power: i128_from_sql(&vp_str)?,
            ledger: ledger as u32,
            tx_index: tx_index as u32,
            event_index: event_index as u32,
            proposer,
            eta: eta.map(|e| e as u64),
        });
    }

    Ok(items)
}
