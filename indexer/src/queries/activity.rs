//! Unified activity feed for one address (Issue #357).
//!
//! Interleaves owner-role and keeper-role events chronologically into a single
//! feed, tagged with the active role for user dashboards.

use crate::events::EventPayload;
use crate::store::Store;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActivityRole {
    Owner,
    Keeper,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ActivityItem {
    pub cursor: i64,
    pub ledger: u32,
    pub ledger_close_time: i64,
    pub role: ActivityRole,
    pub event_type: String,
    pub task_id: Option<u64>,
    pub amount: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AddressActivityFeed {
    pub address: String,
    pub items: Vec<ActivityItem>,
    pub total_count: usize,
}

/// Retrieves chronological unified activity feed for an address across all roles.
pub async fn get_address_activity(
    store: &Store,
    address: &str,
    limit: usize,
    offset: usize,
) -> Result<AddressActivityFeed> {
    let page = store
        .events_after(None, 10_000, None, Some(address))
        .await
        .context("Failed to load events for activity feed")?;

    let mut feed_items = Vec::new();

    for ev in page.events {
        match &ev.payload {
            EventPayload::TaskRegistered {
                task_id,
                owner,
                reward,
                ..
            } => {
                if owner == address {
                    feed_items.push(ActivityItem {
                        cursor: ev.cursor,
                        ledger: ev.ledger,
                        ledger_close_time: ev.ledger_close_time,
                        role: ActivityRole::Owner,
                        event_type: "task_registered".to_string(),
                        task_id: Some(*task_id),
                        amount: Some(reward.0.to_string()),
                    });
                }
            }
            EventPayload::TaskClaimed {
                task_id, keeper, ..
            } => {
                if keeper == address {
                    feed_items.push(ActivityItem {
                        cursor: ev.cursor,
                        ledger: ev.ledger,
                        ledger_close_time: ev.ledger_close_time,
                        role: ActivityRole::Keeper,
                        event_type: "task_claimed".to_string(),
                        task_id: Some(*task_id),
                        amount: None,
                    });
                }
            }
            EventPayload::TaskExecuted {
                task_id,
                keeper,
                net_reward,
                ..
            } => {
                if keeper == address {
                    feed_items.push(ActivityItem {
                        cursor: ev.cursor,
                        ledger: ev.ledger,
                        ledger_close_time: ev.ledger_close_time,
                        role: ActivityRole::Keeper,
                        event_type: "task_executed".to_string(),
                        task_id: Some(*task_id),
                        amount: Some(net_reward.0.to_string()),
                    });
                }
            }
            EventPayload::TaskCancelled { task_id, owner, .. } => {
                if owner == address {
                    feed_items.push(ActivityItem {
                        cursor: ev.cursor,
                        ledger: ev.ledger,
                        ledger_close_time: ev.ledger_close_time,
                        role: ActivityRole::Owner,
                        event_type: "task_cancelled".to_string(),
                        task_id: Some(*task_id),
                        amount: None,
                    });
                }
            }
            EventPayload::RewardsWithdrawn { keeper, amount } => {
                if keeper == address {
                    feed_items.push(ActivityItem {
                        cursor: ev.cursor,
                        ledger: ev.ledger,
                        ledger_close_time: ev.ledger_close_time,
                        role: ActivityRole::Keeper,
                        event_type: "rewards_withdrawn".to_string(),
                        task_id: None,
                        amount: Some(amount.0.to_string()),
                    });
                }
            }
            _ => {}
        }
    }

    let total_count = feed_items.len();
    let paged_items: Vec<ActivityItem> = feed_items.into_iter().skip(offset).take(limit).collect();

    Ok(AddressActivityFeed {
        address: address.to_string(),
        items: paged_items,
        total_count,
    })
}
