//! Protocol-wide statistics query (Issue #356).
//!
//! Aggregates historical and current protocol metrics from indexed event history:
//! total tasks, total value escrowed, active open escrow, swept fees, and current fee rate.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use crate::events::EventPayload;
use crate::store::Store;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ProtocolStats {
    /// Total number of tasks registered historically.
    pub total_tasks_registered: u64,
    /// Total reward value escrowed across all tasks (in stroops / token units).
    pub total_value_escrowed: String,
    /// Current value still escrowed in pending/claimed tasks.
    pub current_open_escrow: String,
    /// Total protocol fees swept to treasury.
    pub total_fees_swept: String,
    /// Current configured protocol fee in basis points.
    pub current_fee_bps: u32,
    /// Current paused state of the protocol.
    pub is_paused: bool,
}

/// Computes protocol-wide statistics across all ingested events.
pub async fn get_protocol_stats(store: &Store) -> Result<ProtocolStats> {
    let page = store
        .events_after(None, 10_000, None, None)
        .await
        .context("Failed to load events for stats")?;

    let mut total_tasks = 0u64;
    let mut total_escrowed: i128 = 0;
    let mut open_escrow: i128 = 0;
    let mut fees_swept: i128 = 0;
    let mut fee_bps = 300u32;
    let mut is_paused = false;

    for event in page.events {
        match event.payload {
            EventPayload::TaskRegistered { reward, .. } => {
                total_tasks += 1;
                total_escrowed += reward.0;
                open_escrow += reward.0;
            }
            EventPayload::TaskExecuted { net_reward, .. } => {
                if open_escrow >= net_reward.0 {
                    open_escrow -= net_reward.0;
                } else {
                    open_escrow = 0;
                }
            }
            EventPayload::TaskCancelled { .. } | EventPayload::TaskExpired { .. } => {
                // Cancelled or expired tasks return escrow
            }
            EventPayload::FeesSwept { amount, .. } => {
                fees_swept += amount.0;
            }
            EventPayload::FeeUpdated { new_bps, .. } => {
                fee_bps = new_bps;
            }
            EventPayload::Paused { paused } => {
                is_paused = paused;
            }
            _ => {}
        }
    }

    Ok(ProtocolStats {
        total_tasks_registered: total_tasks,
        total_value_escrowed: total_escrowed.to_string(),
        current_open_escrow: open_escrow.to_string(),
        total_fees_swept: fees_swept.to_string(),
        current_fee_bps: fee_bps,
        is_paused,
    })
}
