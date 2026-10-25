//! Governance ingestion, proposal lifecycle views, and voter activity feeds (Issue #504).

mod support;

use keeper_indexer::event::{Event, EventCursor, EventPayload};
use keeper_indexer::ingest::governance::{proposal_lifecycle, voter_activity};
use keeper_indexer::ingest_all;

const PROPOSER: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VOTER_A: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VOTER_B: &str = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

fn at(ledger: u32, event_index: u32, payload: EventPayload) -> Event {
    Event::new(EventCursor::new(ledger, 0, event_index), payload)
}

#[tokio::test]
async fn all_governance_events_ingest_and_assemble_lifecycle() {
    let client = skip_without_db!();

    let proposal_id = 1u64;
    let eta = 150_000u64;

    // 1. Proposal Created
    ingest_all(
        &client,
        &[at(
            10,
            0,
            EventPayload::ProposalCreated {
                proposal_id,
                proposer: PROPOSER.to_string(),
                eta,
                action: Some("SetFeeBps(500)".to_string()),
            },
        )],
    )
    .await
    .expect("ingest proposal created failed");

    let lifecycle = proposal_lifecycle(&client, proposal_id)
        .await
        .unwrap()
        .expect("proposal must exist");
    assert_eq!(lifecycle.proposal_id, proposal_id);
    assert_eq!(lifecycle.proposer, PROPOSER);
    assert_eq!(lifecycle.eta, eta);
    assert_eq!(lifecycle.created_ledger, 10);
    assert_eq!(lifecycle.status, "queued");
    assert_eq!(lifecycle.total_votes, 0);

    // 2. Votes Cast
    ingest_all(
        &client,
        &[
            at(
                11,
                0,
                EventPayload::VoteCast {
                    proposal_id,
                    voter: VOTER_A.to_string(),
                    support: 1, // For
                    voting_power: Some(1_000_000),
                },
            ),
            at(
                11,
                1,
                EventPayload::VoteCast {
                    proposal_id,
                    voter: VOTER_B.to_string(),
                    support: 0, // Against
                    voting_power: Some(400_000),
                },
            ),
        ],
    )
    .await
    .expect("ingest votes failed");

    let lifecycle = proposal_lifecycle(&client, proposal_id)
        .await
        .unwrap()
        .expect("proposal must exist");
    assert_eq!(lifecycle.total_votes, 2);
    assert_eq!(lifecycle.votes_for, 1);
    assert_eq!(lifecycle.votes_against, 1);
    assert_eq!(lifecycle.voting_power_for, 1_000_000);
    assert_eq!(lifecycle.voting_power_against, 400_000);

    // 3. Execution
    ingest_all(
        &client,
        &[at(
            12,
            0,
            EventPayload::ProposalExecuted { proposal_id },
        )],
    )
    .await
    .expect("ingest execution failed");

    let lifecycle = proposal_lifecycle(&client, proposal_id)
        .await
        .unwrap()
        .expect("proposal must exist");
    assert_eq!(lifecycle.status, "executed");
    assert_eq!(lifecycle.execution_ledger, Some(12));

    // 4. Voter Activity Feed (Issue 0229 pattern)
    let activity_a = voter_activity(&client, VOTER_A, 10, 0)
        .await
        .expect("load voter activity failed");
    assert_eq!(activity_a.len(), 1);
    assert_eq!(activity_a[0].voter, VOTER_A);
    assert_eq!(activity_a[0].proposal_id, proposal_id);
    assert_eq!(activity_a[0].support, 1);
    assert_eq!(activity_a[0].voting_power, 1_000_000);
}
