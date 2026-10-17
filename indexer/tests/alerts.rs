//! Integration tests for outbound alerts and governance notifications (Issue #505 and Issue #0240).

use std::sync::Arc;

use keeper_indexer::alerts::{
    AdminTransferredRule, AlertManager, AlertRule, AlertSeverity, AlertSystemConfig,
    FeeUpdatedRule, FeesSweptThresholdRule, InMemoryTransport, NewProposalRule,
    PausedRule, VotingWindowClosingSoonRule,
};
use keeper_indexer::event::{Event, EventCursor, EventPayload};

const PROPOSER: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VOTER_A: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VOTER_B: &str = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

fn at(ledger: u32, event_index: u32, payload: EventPayload) -> Event {
    Event::new(EventCursor::new(ledger, 0, event_index), payload)
}

#[tokio::test]
async fn new_proposal_rule_fires_correctly_on_governance_event() {
    let transport = Arc::new(InMemoryTransport::new());
    let rules: Vec<Box<dyn AlertRule>> = vec![Box::new(NewProposalRule)];
    let manager = AlertManager::new(transport.clone(), rules);

    let proposal_id = 101u64;
    let eta = 200_000u64;

    let event = at(
        50,
        0,
        EventPayload::ProposalCreated {
            proposal_id,
            proposer: PROPOSER.to_string(),
            eta,
            action: Some("UpgradeContract(WASM_HASH)".to_string()),
        },
    );

    let dispatched = manager.evaluate(&event).await;
    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].incident, format!("new-proposal:{proposal_id}"));
    assert_eq!(dispatched[0].severity, AlertSeverity::Info);
    assert_eq!(
        dispatched[0].title,
        format!("New Governance Proposal #{proposal_id}")
    );
    assert!(dispatched[0].description.contains(PROPOSER));

    // Confirm delivery through transport
    let stored = transport.get_alerts();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].incident, format!("new-proposal:{proposal_id}"));
}

#[tokio::test]
async fn voting_window_closing_soon_fires_when_unparticipated() {
    let transport = Arc::new(InMemoryTransport::new());
    // Closing window threshold = 2,000 ledgers; monitored voter = VOTER_A
    let rule = VotingWindowClosingSoonRule::new(2_000, Some(VOTER_A.to_string()));
    let manager = AlertManager::new(transport.clone(), vec![Box::new(rule)]);

    let proposal_id = 7u64;
    let eta = 10_000u64;

    // 1. ProposalCreated at ledger 1,000
    let d1 = manager
        .evaluate(&at(
            1_000,
            0,
            EventPayload::ProposalCreated {
                proposal_id,
                proposer: PROPOSER.to_string(),
                eta,
                action: None,
            },
        ))
        .await;
    assert_eq!(d1.len(), 0, "ETA is far; must not fire alert yet");

    // 2. Other votes arrive at ledger 5,000
    let d2 = manager
        .evaluate(&at(
            5_000,
            0,
            EventPayload::VoteCast {
                proposal_id,
                voter: VOTER_B.to_string(),
                support: 1,
                voting_power: Some(250_000),
            },
        ))
        .await;
    assert_eq!(d2.len(), 0, "Still far from closing threshold");

    // 3. Ledger enters closing window at 8,500 (within 2,000 ledgers of 10,000)
    let d3 = manager
        .evaluate(&at(
            8_500,
            0,
            EventPayload::FeeUpdated {
                old_bps: 100,
                new_bps: 150,
            },
        ))
        .await;

    // VOTER_A hasn't voted, so closing window alert must fire!
    assert_eq!(d3.len(), 1);
    assert_eq!(
        d3[0].incident,
        format!("voting-window-closing-soon:{proposal_id}:{VOTER_A}")
    );
    assert_eq!(d3[0].severity, AlertSeverity::Warning);
    assert!(d3[0].description.contains("has not yet voted"));
}

#[tokio::test]
async fn voting_window_closing_soon_suppressed_when_token_holder_voted() {
    let transport = Arc::new(InMemoryTransport::new());
    let rule = VotingWindowClosingSoonRule::new(2_000, Some(VOTER_A.to_string()));
    let manager = AlertManager::new(transport.clone(), vec![Box::new(rule)]);

    let proposal_id = 12u64;
    let eta = 10_000u64;

    // 1. ProposalCreated
    manager
        .evaluate(&at(
            1_000,
            0,
            EventPayload::ProposalCreated {
                proposal_id,
                proposer: PROPOSER.to_string(),
                eta,
                action: None,
            },
        ))
        .await;

    // 2. Target token holder VOTER_A casts vote
    manager
        .evaluate(&at(
            3_000,
            0,
            EventPayload::VoteCast {
                proposal_id,
                voter: VOTER_A.to_string(),
                support: 1,
                voting_power: Some(500_000),
            },
        ))
        .await;

    // 3. Ledger reaches closing window at 9,000
    let d = manager
        .evaluate(&at(
            9_000,
            0,
            EventPayload::Paused { paused: false },
        ))
        .await;

    // Suppressed: token holder has already participated
    assert_eq!(d.len(), 0);
    assert_eq!(transport.get_alerts().len(), 0);
}

#[tokio::test]
async fn both_governance_rules_combined_in_alert_manager() {
    let transport = Arc::new(InMemoryTransport::new());
    let rules: Vec<Box<dyn AlertRule>> = vec![
        Box::new(NewProposalRule),
        Box::new(VotingWindowClosingSoonRule::new(500, Some(VOTER_A.to_string()))),
    ];
    let manager = AlertManager::new(transport.clone(), rules);

    // Ingest events in sequence
    let events = vec![
        at(
            100,
            0,
            EventPayload::ProposalCreated {
                proposal_id: 1,
                proposer: PROPOSER.to_string(),
                eta: 1_000,
                action: Some("SetFeeBps(200)".to_string()),
            },
        ),
        at(
            600,
            0,
            EventPayload::VoteCast {
                proposal_id: 1,
                voter: VOTER_B.to_string(),
                support: 0,
                voting_power: Some(10_000),
            },
        ),
    ];

    let dispatched = manager.process_events(&events).await;

    // Event 1 triggered NewProposalRule.
    // Event 2 at ledger 600 (within 500 ledgers of 1,000) triggered VotingWindowClosingSoonRule.
    assert_eq!(dispatched.len(), 2);
    assert_eq!(dispatched[0].incident, "new-proposal:1");
    assert_eq!(
        dispatched[1].incident,
        format!("voting-window-closing-soon:1:{VOTER_A}")
    );

    // Verify deduplication on re-processing
    let redelivered = manager.process_events(&events).await;
    assert_eq!(
        redelivered.len(),
        0,
        "Redelivered events must be deduplicated"
    );
    assert_eq!(transport.get_alerts().len(), 2);
}

#[tokio::test]
async fn high_signal_registry_rules_fire_accurately() {
    let transport = Arc::new(InMemoryTransport::new());
    let rules: Vec<Box<dyn AlertRule>> = vec![
        Box::new(AdminTransferredRule),
        Box::new(PausedRule),
        Box::new(FeeUpdatedRule),
        Box::new(FeesSweptThresholdRule::new(10_000_000)),
    ];
    let manager = AlertManager::new(transport.clone(), rules);

    // Admin transferred fires
    let d1 = manager
        .evaluate(&at(
            10,
            0,
            EventPayload::AdminTransferred {
                old_admin: "G_OLD".to_string(),
                new_admin: "G_NEW".to_string(),
            },
        ))
        .await;
    assert_eq!(d1.len(), 1);
    assert_eq!(d1[0].rule_id, "admin-transferred");

    // Fee sweep under threshold does not fire
    let d2 = manager
        .evaluate(&at(
            20,
            0,
            EventPayload::FeesSwept {
                treasury: "G_TREASURY".to_string(),
                amount: 9_999_999,
                remaining: 0,
            },
        ))
        .await;
    assert_eq!(d2.len(), 0);

    // Fee sweep over threshold fires
    let d3 = manager
        .evaluate(&at(
            21,
            0,
            EventPayload::FeesSwept {
                treasury: "G_TREASURY".to_string(),
                amount: 15_000_000,
                remaining: 0,
            },
        ))
        .await;
    assert_eq!(d3.len(), 1);
    assert_eq!(d3[0].rule_id, "fees-swept-threshold");
}

#[test]
fn alert_system_config_builds_manager_from_config() {
    let config = AlertSystemConfig {
        webhook_url: None,
        alert_admin_transferred: true,
        alert_protocol_paused: true,
        alert_fee_updated: true,
        fees_swept_threshold: Some(5_000_000),
        alert_new_proposals: true,
        voting_closing_threshold_ledgers: Some(1_000),
        monitored_token_holder: Some(VOTER_A.to_string()),
    };

    let manager = config.build_manager();
    assert_eq!(manager.active_incidents().len(), 0);
}
