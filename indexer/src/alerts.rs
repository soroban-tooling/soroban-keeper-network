//! Alerting infrastructure for high-signal on-chain events and governance notifications.
//!
//! # Overview
//!
//! Originally designed in Issue 0240 for high-signal registry events (admin transfers,
//! emergency pauses, fee updates, high-value fee sweeps), this module is extended
//! in Issue 0505 to support governance proposal notifications and closing voting window
//! alerts for token holders.
//!
//! # Architecture
//!
//! - **[`Alert`]**: Canonical alert payload carrying a deterministic incident key,
//!   severity, title, human-readable description, timestamp, and metadata.
//! - **[`AlertTransport`]**: Pluggable transport trait. Built-in implementations include:
//!   - [`WebhookTransport`]: Outbound HTTP POST to external webhooks (e.g. Slack, Discord, PagerDuty).
//!   - [`InMemoryTransport`]: In-memory capture for integration testing and pipeline assertion.
//!   - [`NoopTransport`]: Discard sink when alerts are disabled.
//! - **[`AlertRule`]**: Pluggable rule trait evaluated at ingestion time.
//! - **[`AlertManager`]**: Orchestrates evaluation, enforces idempotency and deduplication
//!   so that duplicate event delivery or ledger replay triggers exactly one notification.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::event::{Event, EventCursor, EventPayload};

/// Severity level of an alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    Info,
    Warning,
    Critical,
}

/// A structured alert ready for dispatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alert {
    /// Unique incident identifier used for deduplication (e.g., `new-proposal:1`,
    /// `voting-window-closing-soon:1:GB...`).
    pub incident: String,
    /// Identifier of the rule that generated this alert.
    pub rule_id: String,
    /// Alert severity.
    pub severity: AlertSeverity,
    /// Brief title.
    pub title: String,
    /// Detailed description.
    pub description: String,
    /// Timestamp when the alert was generated.
    pub timestamp: DateTime<Utc>,
    /// Ledger cursor where the triggering event occurred.
    pub cursor: Option<EventCursor>,
    /// Additional contextual metadata.
    pub metadata: serde_json::Value,
}

/// Errors occurring during alert processing or dispatch.
#[derive(Debug, thiserror::Error)]
pub enum AlertError {
    #[error("transport error: {0}")]
    Transport(String),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

// ─────────────────────────────────────────────────────────────────────────────
// Pluggable Transports
// ─────────────────────────────────────────────────────────────────────────────

/// Pluggable transport interface for outbound alert notifications.
pub trait AlertTransport: Send + Sync {
    /// Send an alert payload asynchronously.
    fn send<'a>(&'a self, alert: &'a Alert) -> BoxFuture<'a, Result<(), AlertError>>;
}

/// Reference webhook transport for sending alert JSON payloads to an HTTP endpoint.
#[derive(Debug, Clone)]
pub struct WebhookTransport {
    url: String,
    client: reqwest::Client,
}

impl WebhookTransport {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            client: reqwest::Client::new(),
        }
    }

    pub fn with_client(url: impl Into<String>, client: reqwest::Client) -> Self {
        Self {
            url: url.into(),
            client,
        }
    }
}

impl AlertTransport for WebhookTransport {
    fn send<'a>(&'a self, alert: &'a Alert) -> BoxFuture<'a, Result<(), AlertError>> {
        Box::pin(async move {
            let res = self
                .client
                .post(&self.url)
                .json(alert)
                .send()
                .await
                .map_err(|e| AlertError::Transport(e.to_string()))?;

            if !res.status().is_success() {
                return Err(AlertError::Transport(format!(
                    "webhook responded with HTTP {}",
                    res.status()
                )));
            }

            Ok(())
        })
    }
}

/// In-memory transport recording alerts for testing and programmatic assertion.
#[derive(Debug, Default, Clone)]
pub struct InMemoryTransport {
    alerts: Arc<Mutex<Vec<Alert>>>,
}

impl InMemoryTransport {
    pub fn new() -> Self {
        Self {
            alerts: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn get_alerts(&self) -> Vec<Alert> {
        self.alerts.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.alerts.lock().unwrap().clear();
    }
}

impl AlertTransport for InMemoryTransport {
    fn send<'a>(&'a self, alert: &'a Alert) -> BoxFuture<'a, Result<(), AlertError>> {
        self.alerts.lock().unwrap().push(alert.clone());
        Box::pin(async move { Ok(()) })
    }
}

/// No-op transport when alerts are disabled.
#[derive(Debug, Default, Clone)]
pub struct NoopTransport;

impl AlertTransport for NoopTransport {
    fn send<'a>(&'a self, _alert: &'a Alert) -> BoxFuture<'a, Result<(), AlertError>> {
        Box::pin(async move { Ok(()) })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Rule Trait
// ─────────────────────────────────────────────────────────────────────────────

/// An alert rule evaluated against incoming contract events or ledger states.
pub trait AlertRule: Send + Sync {
    /// Distinct identifier of the rule.
    fn id(&self) -> &str;

    /// Evaluate an ingested event and return any triggered alerts.
    fn evaluate(&self, event: &Event) -> Vec<Alert>;

    /// Check against a ledger sequence (e.g. for window closing timers).
    fn check_ledger(&self, _current_ledger: u64) -> Vec<Alert> {
        Vec::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry Alert Rules (Issue 0240)
// ─────────────────────────────────────────────────────────────────────────────

/// Alert rule for contract admin key migration.
#[derive(Debug, Default)]
pub struct AdminTransferredRule;

impl AlertRule for AdminTransferredRule {
    fn id(&self) -> &str {
        "admin-transferred"
    }

    fn evaluate(&self, event: &Event) -> Vec<Alert> {
        if let EventPayload::AdminTransferred {
            old_admin,
            new_admin,
        } = &event.payload
        {
            vec![Alert {
                incident: format!(
                    "{}:{}:{}:{}",
                    self.id(),
                    event.cursor.ledger,
                    event.cursor.tx_index,
                    event.cursor.event_index
                ),
                rule_id: self.id().to_string(),
                severity: AlertSeverity::Critical,
                title: "Admin Transferred".to_string(),
                description: format!("Admin transferred from {old_admin} to {new_admin}"),
                timestamp: Utc::now(),
                cursor: Some(event.cursor),
                metadata: serde_json::json!({
                    "old_admin": old_admin,
                    "new_admin": new_admin,
                }),
            }]
        } else {
            Vec::new()
        }
    }
}

/// Alert rule for emergency protocol pausing.
#[derive(Debug, Default)]
pub struct PausedRule;

impl AlertRule for PausedRule {
    fn id(&self) -> &str {
        "protocol-paused"
    }

    fn evaluate(&self, event: &Event) -> Vec<Alert> {
        if let EventPayload::Paused { paused: true } = &event.payload {
            vec![Alert {
                incident: format!(
                    "{}:{}:{}:{}",
                    self.id(),
                    event.cursor.ledger,
                    event.cursor.tx_index,
                    event.cursor.event_index
                ),
                rule_id: self.id().to_string(),
                severity: AlertSeverity::Critical,
                title: "Protocol Paused".to_string(),
                description: "Keeper registry contract has been paused by admin".to_string(),
                timestamp: Utc::now(),
                cursor: Some(event.cursor),
                metadata: serde_json::json!({ "paused": true }),
            }]
        } else {
            Vec::new()
        }
    }
}

/// Alert rule for fee parameter updates.
#[derive(Debug, Default)]
pub struct FeeUpdatedRule;

impl AlertRule for FeeUpdatedRule {
    fn id(&self) -> &str {
        "fee-updated"
    }

    fn evaluate(&self, event: &Event) -> Vec<Alert> {
        if let EventPayload::FeeUpdated { old_bps, new_bps } = &event.payload {
            vec![Alert {
                incident: format!(
                    "{}:{}:{}:{}",
                    self.id(),
                    event.cursor.ledger,
                    event.cursor.tx_index,
                    event.cursor.event_index
                ),
                rule_id: self.id().to_string(),
                severity: AlertSeverity::Warning,
                title: "Protocol Fee Updated".to_string(),
                description: format!("Protocol fee changed from {old_bps} bps to {new_bps} bps"),
                timestamp: Utc::now(),
                cursor: Some(event.cursor),
                metadata: serde_json::json!({
                    "old_bps": old_bps,
                    "new_bps": new_bps,
                }),
            }]
        } else {
            Vec::new()
        }
    }
}

/// Alert rule for fee sweeps exceeding a configurable threshold.
#[derive(Debug)]
pub struct FeesSweptThresholdRule {
    pub min_amount: i128,
}

impl FeesSweptThresholdRule {
    pub fn new(min_amount: i128) -> Self {
        Self { min_amount }
    }
}

impl AlertRule for FeesSweptThresholdRule {
    fn id(&self) -> &str {
        "fees-swept-threshold"
    }

    fn evaluate(&self, event: &Event) -> Vec<Alert> {
        if let EventPayload::FeesSwept {
            treasury,
            amount,
            remaining,
        } = &event.payload
        {
            if *amount >= self.min_amount {
                return vec![Alert {
                    incident: format!(
                        "{}:{}:{}:{}",
                        self.id(),
                        event.cursor.ledger,
                        event.cursor.tx_index,
                        event.cursor.event_index
                    ),
                    rule_id: self.id().to_string(),
                    severity: AlertSeverity::Info,
                    title: "High Value Fees Swept".to_string(),
                    description: format!(
                        "Fees swept to {treasury}: amount {amount} stroops (threshold: {})",
                        self.min_amount
                    ),
                    timestamp: Utc::now(),
                    cursor: Some(event.cursor),
                    metadata: serde_json::json!({
                        "treasury": treasury,
                        "amount": amount.to_string(),
                        "remaining": remaining.to_string(),
                        "threshold": self.min_amount.to_string(),
                    }),
                }];
            }
        }
        Vec::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance Alert Rules (Issue 0505)
// ─────────────────────────────────────────────────────────────────────────────

/// Alert rule notifying token holders when a new proposal is created.
#[derive(Debug, Default)]
pub struct NewProposalRule;

impl AlertRule for NewProposalRule {
    fn id(&self) -> &str {
        "new-proposal"
    }

    fn evaluate(&self, event: &Event) -> Vec<Alert> {
        if let EventPayload::ProposalCreated {
            proposal_id,
            proposer,
            eta,
            action,
        } = &event.payload
        {
            vec![Alert {
                incident: format!("{}:{}", self.id(), proposal_id),
                rule_id: self.id().to_string(),
                severity: AlertSeverity::Info,
                title: format!("New Governance Proposal #{proposal_id}"),
                description: format!(
                    "Proposal #{proposal_id} created by {proposer} with voting deadline ETA {eta}"
                ),
                timestamp: Utc::now(),
                cursor: Some(event.cursor),
                metadata: serde_json::json!({
                    "proposal_id": proposal_id,
                    "proposer": proposer,
                    "eta": eta,
                    "action": action,
                }),
            }]
        } else {
            Vec::new()
        }
    }
}

#[derive(Debug, Clone)]
struct TrackedProposal {
    proposal_id: u64,
    proposer: String,
    eta: u64,
}

#[derive(Debug, Default)]
struct VotingTrackerState {
    proposals: HashMap<u64, TrackedProposal>,
    votes: HashSet<(u64, String)>, // (proposal_id, voter)
    closed: HashSet<u64>,
}

/// Alert rule notifying a token holder when a voting window they have not yet
/// participated in is about to close.
#[derive(Debug)]
pub struct VotingWindowClosingSoonRule {
    /// Number of ledgers before ETA at which the closing window begins.
    pub closing_threshold_ledgers: u64,
    /// Target voter address to check participation for.
    /// If `Some(address)`, alerts only if this address has NOT voted on the proposal.
    /// If `None`, alerts for all proposals entering the closing window.
    pub token_holder: Option<String>,
    state: Mutex<VotingTrackerState>,
}

impl VotingWindowClosingSoonRule {
    pub fn new(closing_threshold_ledgers: u64, token_holder: Option<String>) -> Self {
        Self {
            closing_threshold_ledgers,
            token_holder,
            state: Mutex::new(VotingTrackerState::default()),
        }
    }

    fn check_proposal_closing(&self, prop: &TrackedProposal, current_ledger: u64) -> Option<Alert> {
        if current_ledger + self.closing_threshold_ledgers >= prop.eta && current_ledger < prop.eta {
            let state = self.state.lock().unwrap();
            if let Some(target) = &self.token_holder {
                if state.votes.contains(&(prop.proposal_id, target.clone())) {
                    return None; // Token holder already voted!
                }

                Some(Alert {
                    incident: format!(
                        "{}:{}:{}",
                        self.id(),
                        prop.proposal_id,
                        target
                    ),
                    rule_id: self.id().to_string(),
                    severity: AlertSeverity::Warning,
                    title: format!(
                        "Voting Window Closing Soon for Proposal #{}",
                        prop.proposal_id
                    ),
                    description: format!(
                        "Voting window for proposal #{} closes at ledger {} (within {} ledgers); token holder {} has not yet voted",
                        prop.proposal_id, prop.eta, self.closing_threshold_ledgers, target
                    ),
                    timestamp: Utc::now(),
                    cursor: None,
                    metadata: serde_json::json!({
                        "proposal_id": prop.proposal_id,
                        "proposer": prop.proposer,
                        "eta": prop.eta,
                        "current_ledger": current_ledger,
                        "token_holder": target,
                        "voted": false,
                    }),
                })
            } else {
                Some(Alert {
                    incident: format!("{}:{}", self.id(), prop.proposal_id),
                    rule_id: self.id().to_string(),
                    severity: AlertSeverity::Warning,
                    title: format!(
                        "Voting Window Closing Soon for Proposal #{}",
                        prop.proposal_id
                    ),
                    description: format!(
                        "Voting window for proposal #{} closes at ledger {} (within {} ledgers)",
                        prop.proposal_id, prop.eta, self.closing_threshold_ledgers
                    ),
                    timestamp: Utc::now(),
                    cursor: None,
                    metadata: serde_json::json!({
                        "proposal_id": prop.proposal_id,
                        "proposer": prop.proposer,
                        "eta": prop.eta,
                        "current_ledger": current_ledger,
                    }),
                })
            }
        } else {
            None
        }
    }
}

impl AlertRule for VotingWindowClosingSoonRule {
    fn id(&self) -> &str {
        "voting-window-closing-soon"
    }

    fn evaluate(&self, event: &Event) -> Vec<Alert> {
        let current_ledger = event.cursor.ledger as u64;

        // Update state based on event
        match &event.payload {
            EventPayload::ProposalCreated {
                proposal_id,
                proposer,
                eta,
                ..
            } => {
                let mut state = self.state.lock().unwrap();
                state.proposals.insert(
                    *proposal_id,
                    TrackedProposal {
                        proposal_id: *proposal_id,
                        proposer: proposer.clone(),
                        eta: *eta,
                    },
                );
            }
            EventPayload::VoteCast {
                proposal_id,
                voter,
                ..
            } => {
                let mut state = self.state.lock().unwrap();
                state.votes.insert((*proposal_id, voter.clone()));
            }
            EventPayload::ProposalExecuted { proposal_id }
            | EventPayload::ProposalExecutionFailed { proposal_id }
            | EventPayload::ProposalCancelled { proposal_id } => {
                let mut state = self.state.lock().unwrap();
                state.closed.insert(*proposal_id);
            }
            _ => {}
        }

        // Check closing status for all open proposals
        let open_props: Vec<TrackedProposal> = {
            let state = self.state.lock().unwrap();
            state
                .proposals
                .values()
                .filter(|p| !state.closed.contains(&p.proposal_id))
                .cloned()
                .collect()
        };

        let mut alerts = Vec::new();
        for prop in open_props {
            if let Some(mut alert) = self.check_proposal_closing(&prop, current_ledger) {
                alert.cursor = Some(event.cursor);
                alerts.push(alert);
            }
        }
        alerts
    }

    fn check_ledger(&self, current_ledger: u64) -> Vec<Alert> {
        let open_props: Vec<TrackedProposal> = {
            let state = self.state.lock().unwrap();
            state
                .proposals
                .values()
                .filter(|p| !state.closed.contains(&p.proposal_id))
                .cloned()
                .collect()
        };

        let mut alerts = Vec::new();
        for prop in open_props {
            if let Some(alert) = self.check_proposal_closing(&prop, current_ledger) {
                alerts.push(alert);
            }
        }
        alerts
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Manager (Deduplication & Ingestion Pipeline Integration)
// ─────────────────────────────────────────────────────────────────────────────

/// Alert manager coordinating evaluation, deduplication, and dispatch.
pub struct AlertManager {
    transport: Arc<dyn AlertTransport>,
    rules: Vec<Box<dyn AlertRule>>,
    active_incidents: Arc<Mutex<HashSet<String>>>,
}

impl AlertManager {
    /// Create a new alert manager with the given transport and rule set.
    pub fn new(transport: Arc<dyn AlertTransport>, rules: Vec<Box<dyn AlertRule>>) -> Self {
        Self {
            transport,
            rules,
            active_incidents: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Evaluate an event against all configured alert rules.
    ///
    /// Deduplicates incidents: each matched incident fires exactly once.
    /// Returns the alerts that were dispatched.
    pub async fn evaluate(&self, event: &Event) -> Vec<Alert> {
        let mut dispatched = Vec::new();

        for rule in &self.rules {
            let alerts = rule.evaluate(event);
            for alert in alerts {
                let is_new = {
                    let mut incidents = self.active_incidents.lock().unwrap();
                    incidents.insert(alert.incident.clone())
                };

                if is_new {
                    if let Err(err) = self.transport.send(&alert).await {
                        tracing::error!(
                            incident = %alert.incident,
                            error = %err,
                            "failed to send alert via transport"
                        );
                    }
                    dispatched.push(alert);
                }
            }
        }

        dispatched
    }

    /// Check rules against a ledger sequence (e.g. at ledger close intervals).
    pub async fn check_ledger(&self, ledger: u64) -> Vec<Alert> {
        let mut dispatched = Vec::new();

        for rule in &self.rules {
            let alerts = rule.check_ledger(ledger);
            for alert in alerts {
                let is_new = {
                    let mut incidents = self.active_incidents.lock().unwrap();
                    incidents.insert(alert.incident.clone())
                };

                if is_new {
                    if let Err(err) = self.transport.send(&alert).await {
                        tracing::error!(
                            incident = %alert.incident,
                            error = %err,
                            "failed to send ledger-checked alert via transport"
                        );
                    }
                    dispatched.push(alert);
                }
            }
        }

        dispatched
    }

    /// Evaluate a batch of events sequentially.
    pub async fn process_events(&self, events: &[Event]) -> Vec<Alert> {
        let mut all_dispatched = Vec::new();
        for event in events {
            let dispatched = self.evaluate(event).await;
            all_dispatched.extend(dispatched);
        }
        all_dispatched
    }

    /// Clear an active incident so it may re-trigger if conditions recur.
    pub fn clear_incident(&self, incident: &str) {
        self.active_incidents.lock().unwrap().remove(incident);
    }

    /// Inspect active incidents (for tests and observability).
    pub fn active_incidents(&self) -> HashSet<String> {
        self.active_incidents.lock().unwrap().clone()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration without code changes (Issue 0240 AC)
// ─────────────────────────────────────────────────────────────────────────────

/// Configuration for the indexer alert system, deserializable from config files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertSystemConfig {
    /// Optional outbound webhook URL. If omitted, uses NoopTransport.
    pub webhook_url: Option<String>,
    /// Enable admin transfer alerts.
    #[serde(default)]
    pub alert_admin_transferred: bool,
    /// Enable protocol pause alerts.
    #[serde(default)]
    pub alert_protocol_paused: bool,
    /// Enable fee change alerts.
    #[serde(default)]
    pub alert_fee_updated: bool,
    /// Threshold for high-value fee sweep alerts (None to disable).
    pub fees_swept_threshold: Option<i128>,
    /// Enable governance new-proposal alerts (Issue 0505).
    #[serde(default)]
    pub alert_new_proposals: bool,
    /// Closing threshold in ledgers for governance voting closing soon alerts.
    pub voting_closing_threshold_ledgers: Option<u64>,
    /// Monitored token holder address for unparticipated voting alerts.
    pub monitored_token_holder: Option<String>,
}

impl AlertSystemConfig {
    /// Build an [`AlertManager`] directly from this configuration.
    pub fn build_manager(&self) -> AlertManager {
        let transport: Arc<dyn AlertTransport> = match &self.webhook_url {
            Some(url) if !url.trim().is_empty() => Arc::new(WebhookTransport::new(url)),
            _ => Arc::new(NoopTransport),
        };

        let mut rules: Vec<Box<dyn AlertRule>> = Vec::new();

        if self.alert_admin_transferred {
            rules.push(Box::new(AdminTransferredRule));
        }
        if self.alert_protocol_paused {
            rules.push(Box::new(PausedRule));
        }
        if self.alert_fee_updated {
            rules.push(Box::new(FeeUpdatedRule));
        }
        if let Some(threshold) = self.fees_swept_threshold {
            rules.push(Box::new(FeesSweptThresholdRule::new(threshold)));
        }
        if self.alert_new_proposals {
            rules.push(Box::new(NewProposalRule));
        }
        if let Some(threshold) = self.voting_closing_threshold_ledgers {
            rules.push(Box::new(VotingWindowClosingSoonRule::new(
                threshold,
                self.monitored_token_holder.clone(),
            )));
        }

        AlertManager::new(transport, rules)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests (Issue 0240 & Issue 0505 Acceptance Criteria)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const PROPOSER: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const VOTER_A: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const VOTER_B: &str = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    fn at(ledger: u32, event_index: u32, payload: EventPayload) -> Event {
        Event::new(EventCursor::new(ledger, 0, event_index), payload)
    }

    #[tokio::test]
    async fn new_proposal_rule_fires_on_governance_event() {
        let transport = Arc::new(InMemoryTransport::new());
        let rules: Vec<Box<dyn AlertRule>> = vec![Box::new(NewProposalRule)];
        let manager = AlertManager::new(transport.clone(), rules);

        let event = at(
            100,
            0,
            EventPayload::ProposalCreated {
                proposal_id: 42,
                proposer: PROPOSER.to_string(),
                eta: 105_000,
                action: Some("SetFeeBps(300)".to_string()),
            },
        );

        let dispatched = manager.evaluate(&event).await;
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].incident, "new-proposal:42");
        assert_eq!(dispatched[0].severity, AlertSeverity::Info);
        assert!(dispatched[0].title.contains("#42"));
        assert!(dispatched[0].description.contains(PROPOSER));

        let stored = transport.get_alerts();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].incident, "new-proposal:42");
    }

    #[tokio::test]
    async fn voting_window_closing_soon_fires_if_voter_has_not_voted() {
        let transport = Arc::new(InMemoryTransport::new());
        // Closing window: 1,000 ledgers; monitor VOTER_A
        let rule = VotingWindowClosingSoonRule::new(1_000, Some(VOTER_A.to_string()));
        let rules: Vec<Box<dyn AlertRule>> = vec![Box::new(rule)];
        let manager = AlertManager::new(transport.clone(), rules);

        // 1. Proposal created with ETA = 5,000 at ledger 1,000
        let prop_event = at(
            1_000,
            0,
            EventPayload::ProposalCreated {
                proposal_id: 1,
                proposer: PROPOSER.to_string(),
                eta: 5_000,
                action: None,
            },
        );
        let d1 = manager.evaluate(&prop_event).await;
        // Ledger 1,000 + 1,000 threshold < 5,000 ETA -> should NOT fire
        assert_eq!(d1.len(), 0);

        // 2. Someone else (VOTER_B) votes at ledger 2,000
        let vote_b = at(
            2_000,
            0,
            EventPayload::VoteCast {
                proposal_id: 1,
                voter: VOTER_B.to_string(),
                support: 1,
                voting_power: Some(50_000),
            },
        );
        let d2 = manager.evaluate(&vote_b).await;
        assert_eq!(d2.len(), 0);

        // 3. Chain advances to ledger 4,200 (within 1,000 ledgers of 5,000 ETA)
        let advance_event = at(
            4_200,
            0,
            EventPayload::FeeUpdated {
                old_bps: 10,
                new_bps: 20,
            },
        );
        let d3 = manager.evaluate(&advance_event).await;
        // VOTER_A has not yet voted, so alert must fire!
        assert_eq!(d3.len(), 1);
        assert_eq!(
            d3[0].incident,
            format!("voting-window-closing-soon:1:{VOTER_A}")
        );
        assert_eq!(d3[0].severity, AlertSeverity::Warning);
        assert!(d3[0].description.contains("has not yet voted"));
    }

    #[tokio::test]
    async fn voting_window_closing_soon_does_not_fire_if_voter_already_voted() {
        let transport = Arc::new(InMemoryTransport::new());
        let rule = VotingWindowClosingSoonRule::new(1_000, Some(VOTER_A.to_string()));
        let rules: Vec<Box<dyn AlertRule>> = vec![Box::new(rule)];
        let manager = AlertManager::new(transport.clone(), rules);

        // 1. Proposal created with ETA = 5,000 at ledger 1,000
        manager
            .evaluate(&at(
                1_000,
                0,
                EventPayload::ProposalCreated {
                    proposal_id: 1,
                    proposer: PROPOSER.to_string(),
                    eta: 5_000,
                    action: None,
                },
            ))
            .await;

        // 2. Monitored voter VOTER_A votes at ledger 2,500
        manager
            .evaluate(&at(
                2_500,
                0,
                EventPayload::VoteCast {
                    proposal_id: 1,
                    voter: VOTER_A.to_string(),
                    support: 1,
                    voting_power: Some(100_000),
                },
            ))
            .await;

        // 3. Chain enters closing window at ledger 4,500
        let advance_event = at(
            4_500,
            0,
            EventPayload::Paused { paused: false },
        );
        let alerts = manager.evaluate(&advance_event).await;
        // VOTER_A already voted! Must NOT fire.
        assert_eq!(alerts.len(), 0);
        assert_eq!(transport.get_alerts().len(), 0);
    }

    #[tokio::test]
    async fn deduplication_prevents_duplicate_notifications_on_retry() {
        let transport = Arc::new(InMemoryTransport::new());
        let rules: Vec<Box<dyn AlertRule>> = vec![Box::new(NewProposalRule)];
        let manager = AlertManager::new(transport.clone(), rules);

        let event = at(
            500,
            0,
            EventPayload::ProposalCreated {
                proposal_id: 7,
                proposer: PROPOSER.to_string(),
                eta: 50_000,
                action: None,
            },
        );

        // First delivery: fires once
        let d1 = manager.evaluate(&event).await;
        assert_eq!(d1.len(), 1);

        // Retry / duplicate delivery: deduplicated!
        let d2 = manager.evaluate(&event).await;
        assert_eq!(d2.len(), 0);

        // Third delivery: still deduplicated
        let d3 = manager.evaluate(&event).await;
        assert_eq!(d3.len(), 0);

        // Total notifications sent via transport must strictly be 1
        assert_eq!(transport.get_alerts().len(), 1);
    }

    #[tokio::test]
    async fn registry_rules_fire_only_on_matching_events() {
        let transport = Arc::new(InMemoryTransport::new());
        let rules: Vec<Box<dyn AlertRule>> = vec![
            Box::new(AdminTransferredRule),
            Box::new(PausedRule),
            Box::new(FeeUpdatedRule),
            Box::new(FeesSweptThresholdRule::new(1_000_000)),
        ];
        let manager = AlertManager::new(transport.clone(), rules);

        // 1. Admin transferred
        let e1 = at(
            10,
            0,
            EventPayload::AdminTransferred {
                old_admin: "G_OLD".to_string(),
                new_admin: "G_NEW".to_string(),
            },
        );
        let a1 = manager.evaluate(&e1).await;
        assert_eq!(a1.len(), 1);
        assert_eq!(a1[0].rule_id, "admin-transferred");

        // 2. Protocol paused
        let e2 = at(20, 0, EventPayload::Paused { paused: true });
        let a2 = manager.evaluate(&e2).await;
        assert_eq!(a2.len(), 1);
        assert_eq!(a2[0].rule_id, "protocol-paused");

        // 3. Protocol unpaused -> does NOT fire
        let e3 = at(21, 0, EventPayload::Paused { paused: false });
        let a3 = manager.evaluate(&e3).await;
        assert_eq!(a3.len(), 0);

        // 4. Fee sweep under threshold (500_000 < 1_000_000) -> does NOT fire
        let e4 = at(
            30,
            0,
            EventPayload::FeesSwept {
                treasury: "G_TREASURY".to_string(),
                amount: 500_000,
                remaining: 0,
            },
        );
        let a4 = manager.evaluate(&e4).await;
        assert_eq!(a4.len(), 0);

        // 5. Fee sweep above threshold (2_000_000 >= 1_000_000) -> fires!
        let e5 = at(
            31,
            0,
            EventPayload::FeesSwept {
                treasury: "G_TREASURY".to_string(),
                amount: 2_000_000,
                remaining: 0,
            },
        );
        let a5 = manager.evaluate(&e5).await;
        assert_eq!(a5.len(), 1);
        assert_eq!(a5[0].rule_id, "fees-swept-threshold");

        // 6. Non-matching event (TaskRegistered) -> does NOT fire
        let e6 = at(
            40,
            0,
            EventPayload::TaskRegistered {
                task_id: 1,
                owner: "G_OWNER".to_string(),
                reward: 100,
                deadline: 1000,
            },
        );
        let a6 = manager.evaluate(&e6).await;
        assert_eq!(a6.len(), 0);

        // Check total stored alerts
        assert_eq!(transport.get_alerts().len(), 3);
    }

    #[test]
    fn config_deserializes_from_json() {
        let json = r#"{
            "webhook_url": "https://hooks.example.com/alerts",
            "alert_admin_transferred": true,
            "alert_protocol_paused": true,
            "alert_fee_updated": false,
            "fees_swept_threshold": 5000000,
            "alert_new_proposals": true,
            "voting_closing_threshold_ledgers": 2880,
            "monitored_token_holder": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        }"#;

        let config: AlertSystemConfig = serde_json::from_str(json).expect("deserialize config");
        assert_eq!(
            config.webhook_url.as_deref(),
            Some("https://hooks.example.com/alerts")
        );
        assert!(config.alert_admin_transferred);
        assert!(config.alert_protocol_paused);
        assert!(!config.alert_fee_updated);
        assert_eq!(config.fees_swept_threshold, Some(5000000));
        assert!(config.alert_new_proposals);
        assert_eq!(config.voting_closing_threshold_ledgers, Some(2880));
        assert_eq!(config.monitored_token_holder.as_deref(), Some(VOTER_A));

        let manager = config.build_manager();
        assert_eq!(manager.rules.len(), 5);
    }
}
