//! Ingestion for governance contract events (issue #504 / backlog 0376).
//!
//! Handles `GovernanceInitialized`, `ProposalCreated`, `VoteCast`, `ProposalPassed`,
//! `ProposalDefeated`, `ProposalQueued`, `ProposalExecuted`, and `ProposalCancelled`.
//!
//! Follows the indexer's idempotency and audit-trail design:
//! All rows are inserted `ON CONFLICT (ledger, tx_index, event_index) DO NOTHING`.

use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Everything that describes a proposal's current state and event history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalLifecycle {
    pub proposal_id: u64,
    pub proposer: String,
    pub created_ledger: u64,
    pub voting_end: u64,
    pub status: String,
    pub eta: Option<u64>,
    pub status_ledger: Option<u64>,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub total_votes_cast: i64,
}

/// A single recorded vote in an address's voting history feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressVoteRecord {
    pub voter: String,
    pub proposal_id: u64,
    pub choice: u32,
    pub choice_label: String,
    pub weight: i128,
    pub ledger: u64,
    pub tx_index: u64,
    pub event_index: u64,
    pub proposal_proposer: String,
    pub proposal_voting_end: u64,
}

/// Apply one governance event to the database.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;
    match &event.payload {
        EventPayload::GovernanceInitialized { .. } => {
            // Handled or stored if needed, audit preserved
            Ok(())
        }

        EventPayload::ProposalCreated {
            proposal_id,
            proposer,
            voting_end,
        } => {
            client
                .execute(
                    "INSERT INTO governance_proposals
                       (ledger, tx_index, event_index, proposal_id, proposer, voting_end)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        proposer,
                        &(*voting_end as i64),
                    ],
                )
                .await?;
            Ok(())
        }

        EventPayload::VoteCast {
            proposal_id,
            voter,
            choice,
            weight,
        } => {
            client
                .execute(
                    "INSERT INTO governance_votes
                       (ledger, tx_index, event_index, proposal_id, voter, choice, weight)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        voter,
                        &(*choice as i32),
                        &i128_to_sql(*weight),
                    ],
                )
                .await?;
            Ok(())
        }

        EventPayload::ProposalPassed {
            proposal_id,
            votes_for,
            votes_against,
        } => {
            client
                .execute(
                    "INSERT INTO governance_transitions
                       (ledger, tx_index, event_index, proposal_id, kind, votes_for, votes_against)
                     VALUES ($1, $2, $3, $4, 'passed', $5::text::numeric, $6::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        &i128_to_sql(*votes_for),
                        &i128_to_sql(*votes_against),
                    ],
                )
                .await?;
            Ok(())
        }

        EventPayload::ProposalDefeated {
            proposal_id,
            votes_for_or_total,
            votes_against_or_quorum,
        } => {
            client
                .execute(
                    "INSERT INTO governance_transitions
                       (ledger, tx_index, event_index, proposal_id, kind, total_votes, quorum)
                     VALUES ($1, $2, $3, $4, 'defeated', $5::text::numeric, $6::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        &i128_to_sql(*votes_for_or_total),
                        &i128_to_sql(*votes_against_or_quorum),
                    ],
                )
                .await?;
            Ok(())
        }

        EventPayload::ProposalQueued { proposal_id, eta } => {
            client
                .execute(
                    "INSERT INTO governance_transitions
                       (ledger, tx_index, event_index, proposal_id, kind, eta)
                     VALUES ($1, $2, $3, $4, 'queued', $5)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        &(*eta as i64),
                    ],
                )
                .await?;
            Ok(())
        }

        EventPayload::ProposalExecuted { proposal_id } => {
            client
                .execute(
                    "INSERT INTO governance_transitions
                       (ledger, tx_index, event_index, proposal_id, kind)
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
            Ok(())
        }

        EventPayload::ProposalCancelled {
            proposal_id,
            caller,
        } => {
            client
                .execute(
                    "INSERT INTO governance_transitions
                       (ledger, tx_index, event_index, proposal_id, kind, caller)
                     VALUES ($1, $2, $3, $4, 'cancelled', $5)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        &(*proposal_id as i64),
                        caller,
                    ],
                )
                .await?;
            Ok(())
        }

        _ => Ok(()),
    }
}

/// Query the assembled lifecycle of a proposal from the database view.
pub async fn proposal_lifecycle(
    client: &Client,
    proposal_id: u64,
) -> Result<Option<ProposalLifecycle>, IndexerError> {
    let row = client
        .query_opt(
            "SELECT proposal_id, proposer, created_ledger, voting_end, status, eta, status_ledger,
                    votes_for::text, votes_against::text, votes_abstain::text, total_votes_cast
               FROM governance_proposal_lifecycles
              WHERE proposal_id = $1",
            &[&(proposal_id as i64)],
        )
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    Ok(Some(ProposalLifecycle {
        proposal_id: row.get::<_, i64>(0) as u64,
        proposer: row.get(1),
        created_ledger: row.get::<_, i64>(2) as u64,
        voting_end: row.get::<_, i64>(3) as u64,
        status: row.get(4),
        eta: row.get::<_, Option<i64>>(5).map(|e| e as u64),
        status_ledger: row.get::<_, Option<i64>>(6).map(|l| l as u64),
        votes_for: i128_from_sql(row.get(7))?,
        votes_against: i128_from_sql(row.get(8))?,
        votes_abstain: i128_from_sql(row.get(9))?,
        total_votes_cast: row.get(10),
    }))
}

/// Query the voting history for a voter address from the view.
pub async fn address_votes(
    client: &Client,
    voter: &str,
) -> Result<Vec<AddressVoteRecord>, IndexerError> {
    let rows = client
        .query(
            "SELECT voter, proposal_id, choice, choice_label, weight::text, ledger, tx_index, event_index,
                    proposal_proposer, proposal_voting_end
               FROM governance_address_votes
              WHERE voter = $1
              ORDER BY ledger DESC, tx_index DESC, event_index DESC",
            &[&voter],
        )
        .await?;

    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        records.push(AddressVoteRecord {
            voter: row.get(0),
            proposal_id: row.get::<_, i64>(1) as u64,
            choice: row.get::<_, i32>(2) as u32,
            choice_label: row.get(3),
            weight: i128_from_sql(row.get(4))?,
            ledger: row.get::<_, i64>(5) as u64,
            tx_index: row.get::<_, i64>(6) as u64,
            event_index: row.get::<_, i64>(7) as u64,
            proposal_proposer: row.get(8),
            proposal_voting_end: row.get::<_, i64>(9) as u64,
        });
    }

    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventCursor;

    fn cursor(n: i64) -> EventCursor {
        EventCursor::new(n as u32, 0, 0)
    }

    #[test]
    fn proposal_lifecycle_types_hold_their_fields() {
        let p = ProposalLifecycle {
            proposal_id: 1,
            proposer: "GPROPOSER".into(),
            created_ledger: 100,
            voting_end: 200,
            status: "active".into(),
            eta: None,
            status_ledger: None,
            votes_for: 50_000,
            votes_against: 10_000,
            votes_abstain: 5_000,
            total_votes_cast: 3,
        };
        assert_eq!(p.proposal_id, 1);
        assert_eq!(p.status, "active");
        assert_eq!(p.votes_for, 50_000);
        assert_eq!(p.total_votes_cast, 3);
    }

    #[test]
    fn address_vote_record_holds_fields() {
        let v = AddressVoteRecord {
            voter: "GVOTER".into(),
            proposal_id: 42,
            choice: 1,
            choice_label: "for".into(),
            weight: 1_000_000,
            ledger: 150,
            tx_index: 0,
            event_index: 1,
            proposal_proposer: "GPROPOSER".into(),
            proposal_voting_end: 300,
        };
        assert_eq!(v.proposal_id, 42);
        assert_eq!(v.choice_label, "for");
        assert_eq!(v.weight, 1_000_000);
    }

    #[test]
    fn governance_events_construct_properly() {
        let events = [
            EventPayload::GovernanceInitialized {
                admin: "GADMIN".into(),
                kprs_token: "CKPRS".into(),
                registry: "CREGISTRY".into(),
            },
            EventPayload::ProposalCreated {
                proposal_id: 1,
                proposer: "GPROPOSER".into(),
                voting_end: 500,
            },
            EventPayload::VoteCast {
                proposal_id: 1,
                voter: "GVOTER".into(),
                choice: 1,
                weight: 10_000,
            },
            EventPayload::ProposalPassed {
                proposal_id: 1,
                votes_for: 10_000,
                votes_against: 0,
            },
            EventPayload::ProposalQueued {
                proposal_id: 1,
                eta: 600,
            },
            EventPayload::ProposalExecuted { proposal_id: 1 },
        ];
        for event in events {
            let e = Event::new(cursor(1), event);
            assert_eq!(e.cursor.ledger, 1);
        }
    }
}
