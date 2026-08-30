//! Keeper leaderboard.
//!
//! Ranks keepers by tasks executed or by total net reward earned, over all
//! time or over a recent window. Building the aggregation here rather than in
//! the dashboard means every consumer gets the same numbers and the same
//! ordering, instead of each reimplementing the fold client-side.
//!
//! # Tie-breaking
//!
//! Ranking is deterministic and total. Entries are ordered by:
//!
//! 1. the ranking metric, descending -- executions for [`RankBy::Executions`],
//!    total net reward for [`RankBy::Reward`];
//! 2. the other metric, descending, as the first tie-break: between two
//!    keepers with equal executions, the one who earned more ranks higher;
//!    between two with equal earnings, the one who did more work ranks higher;
//! 3. the keeper address, ascending lexicographically, as the final
//!    tie-break.
//!
//! Because addresses are unique, step 3 always resolves. The same dataset
//! therefore always produces the same order, no matter what order the rows
//! came back in -- which is what makes a paged or cached leaderboard stable.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::events::{EventPayload, I128};
use crate::store::Store;

/// Which metric to rank by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RankBy {
    /// Tasks executed, most first.
    Executions,
    /// Total net reward earned, most first.
    Reward,
}

impl RankBy {
    /// Parse the wire name used in the API query string.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "executions" => Some(Self::Executions),
            "reward" => Some(Self::Reward),
            _ => None,
        }
    }
}

/// One keeper's position on the leaderboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct LeaderboardEntry {
    /// 1-based position after ordering and tie-breaking.
    pub rank: u32,
    pub keeper: String,
    /// Tasks executed within the window.
    pub executions: u32,
    /// Net reward earned within the window.
    #[schema(value_type = String)]
    pub total_reward: I128,
}

/// A ranked leaderboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Leaderboard {
    pub rank_by: RankBy,
    /// Start of the window as a Unix timestamp, absent for all-time.
    pub since: Option<i64>,
    pub entries: Vec<LeaderboardEntry>,
}

/// One keeper's totals before ranking.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Totals {
    keeper: String,
    executions: u32,
    total_reward: i128,
}

/// Build a leaderboard over the executions in the store.
///
/// `since` restricts the aggregation to executions at or after that ledger
/// close time; `None` covers all time. `limit` caps the entries returned,
/// applied after ranking so the top N is the true top N.
pub async fn leaderboard(
    store: &Store,
    rank_by: RankBy,
    since: Option<i64>,
    limit: u32,
) -> Result<Leaderboard> {
    // Only TaskExecuted carries net_reward, and only executions count as work
    // done -- a claim that never executed earns nothing and is not a task
    // completed, so neither metric should count it.
    let rows = sqlx::query(
        "SELECT keeper_address, ledger_close_time, payload
         FROM events
         WHERE event_type = 'task_executed'
           AND keeper_address IS NOT NULL
           AND (?1 IS NULL OR ledger_close_time >= ?1)",
    )
    .bind(since)
    .fetch_all(store.pool())
    .await
    .context("reading executions for the leaderboard")?;

    let mut totals: Vec<Totals> = Vec::new();
    for row in rows {
        let keeper: String = row.get("keeper_address");
        let encoded: String = row.get("payload");
        let payload: EventPayload =
            serde_json::from_str(&encoded).context("decoding an execution payload")?;

        let EventPayload::TaskExecuted { net_reward, .. } = payload else {
            // The event_type column said task_executed, so a different payload
            // means the two disagree -- worth failing loudly rather than
            // quietly skipping a row that should have counted.
            anyhow::bail!("event_type task_executed had a {payload:?} payload");
        };

        match totals.iter_mut().find(|t| t.keeper == keeper) {
            Some(existing) => {
                existing.executions += 1;
                existing.total_reward += net_reward.0;
            }
            None => totals.push(Totals {
                keeper,
                executions: 1,
                total_reward: net_reward.0,
            }),
        }
    }

    Ok(Leaderboard {
        rank_by,
        since,
        entries: rank(totals, rank_by, limit),
    })
}

/// Order totals and assign ranks.
///
/// Split out from the query so the ordering rules are testable directly,
/// without a database round trip per case.
fn rank(mut totals: Vec<Totals>, rank_by: RankBy, limit: u32) -> Vec<LeaderboardEntry> {
    totals.sort_by(|a, b| {
        let primary = match rank_by {
            RankBy::Executions => b.executions.cmp(&a.executions),
            RankBy::Reward => b.total_reward.cmp(&a.total_reward),
        };
        primary
            .then_with(|| match rank_by {
                // The other metric breaks a tie on the first.
                RankBy::Executions => b.total_reward.cmp(&a.total_reward),
                RankBy::Reward => b.executions.cmp(&a.executions),
            })
            // Addresses are unique, so this always resolves.
            .then_with(|| a.keeper.cmp(&b.keeper))
    });

    totals
        .into_iter()
        .take(limit as usize)
        .enumerate()
        .map(|(i, t)| LeaderboardEntry {
            rank: i as u32 + 1,
            keeper: t.keeper,
            executions: t.executions,
            total_reward: I128(t.total_reward),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn totals(entries: &[(&str, u32, i128)]) -> Vec<Totals> {
        entries
            .iter()
            .map(|(keeper, executions, total_reward)| Totals {
                keeper: (*keeper).to_string(),
                executions: *executions,
                total_reward: *total_reward,
            })
            .collect()
    }

    async fn store_with_executions(entries: &[(&str, i128, i64)]) -> Store {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        for (i, (keeper, net_reward, close_time)) in entries.iter().enumerate() {
            store
                .insert_event(
                    10 + i as u32,
                    *close_time,
                    &format!("tx{i}"),
                    0,
                    &EventPayload::TaskExecuted {
                        task_id: i as u64,
                        keeper: (*keeper).to_string(),
                        net_reward: I128(*net_reward),
                        proof: "00".into(),
                    },
                )
                .await
                .expect("insert");
        }
        store
    }

    #[test]
    fn ranking_by_executions_orders_by_count_first() {
        let ranked = rank(
            totals(&[("GA", 2, 5_000), ("GB", 5, 100), ("GC", 3, 900)]),
            RankBy::Executions,
            10,
        );

        assert_eq!(ranked[0].keeper, "GB");
        assert_eq!(ranked[1].keeper, "GC");
        assert_eq!(ranked[2].keeper, "GA");
        assert_eq!(ranked[0].rank, 1);
    }

    #[test]
    fn ranking_by_reward_orders_by_earnings_first() {
        let ranked = rank(
            totals(&[("GA", 2, 5_000), ("GB", 5, 100), ("GC", 3, 900)]),
            RankBy::Reward,
            10,
        );

        assert_eq!(ranked[0].keeper, "GA");
        assert_eq!(ranked[1].keeper, "GC");
        assert_eq!(ranked[2].keeper, "GB");
    }

    #[test]
    fn equal_counts_are_broken_by_reward() {
        let ranked = rank(
            totals(&[("GA", 3, 100), ("GB", 3, 900)]),
            RankBy::Executions,
            10,
        );

        // Same executions: the keeper who earned more ranks higher.
        assert_eq!(ranked[0].keeper, "GB");
        assert_eq!(ranked[1].keeper, "GA");
    }

    #[test]
    fn equal_rewards_are_broken_by_execution_count() {
        let ranked = rank(
            totals(&[("GA", 1, 500), ("GB", 4, 500)]),
            RankBy::Reward,
            10,
        );

        // Same earnings: the keeper who did more work ranks higher.
        assert_eq!(ranked[0].keeper, "GB");
        assert_eq!(ranked[1].keeper, "GA");
    }

    #[test]
    fn a_complete_tie_is_broken_by_address_so_ordering_is_total() {
        // Identical on both metrics: only the address can separate them, and
        // it always can, because addresses are unique.
        let forward = rank(
            totals(&[("GAAA", 3, 300), ("GBBB", 3, 300), ("GCCC", 3, 300)]),
            RankBy::Executions,
            10,
        );
        let reversed = rank(
            totals(&[("GCCC", 3, 300), ("GBBB", 3, 300), ("GAAA", 3, 300)]),
            RankBy::Executions,
            10,
        );

        let order: Vec<&str> = forward.iter().map(|e| e.keeper.as_str()).collect();
        assert_eq!(order, vec!["GAAA", "GBBB", "GCCC"]);

        // Input order must not change the result, or a cached page and a fresh
        // one could disagree.
        assert_eq!(forward, reversed);
    }

    #[test]
    fn ranks_are_sequential_from_one() {
        let ranked = rank(
            totals(&[("GA", 5, 10), ("GB", 3, 10), ("GC", 1, 10)]),
            RankBy::Executions,
            10,
        );
        assert_eq!(
            ranked.iter().map(|e| e.rank).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn the_limit_is_applied_after_ranking() {
        let ranked = rank(
            totals(&[("GA", 1, 10), ("GB", 9, 10), ("GC", 5, 10)]),
            RankBy::Executions,
            2,
        );

        // The true top two, not the first two rows encountered.
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].keeper, "GB");
        assert_eq!(ranked[1].keeper, "GC");
    }

    #[tokio::test]
    async fn an_empty_store_yields_an_empty_leaderboard() {
        let store = Store::connect("sqlite::memory:").await.expect("store");
        let board = leaderboard(&store, RankBy::Executions, None, 10)
            .await
            .expect("query");
        assert!(board.entries.is_empty());
    }

    #[tokio::test]
    async fn all_time_ranking_matches_a_manual_aggregation() {
        // A fixed dataset, aggregated by hand:
        //   GKEEPER1: 3 executions, 100 + 250 + 50  = 400
        //   GKEEPER2: 2 executions, 500 + 500       = 1000
        //   GKEEPER3: 1 execution,  900             = 900
        let store = store_with_executions(&[
            ("GKEEPER1", 100, 1_000),
            ("GKEEPER2", 500, 1_100),
            ("GKEEPER1", 250, 1_200),
            ("GKEEPER3", 900, 1_300),
            ("GKEEPER2", 500, 1_400),
            ("GKEEPER1", 50, 1_500),
        ])
        .await;

        let by_count = leaderboard(&store, RankBy::Executions, None, 10)
            .await
            .expect("query");
        assert_eq!(
            by_count
                .entries
                .iter()
                .map(|e| (e.keeper.as_str(), e.executions, e.total_reward.0))
                .collect::<Vec<_>>(),
            vec![
                ("GKEEPER1", 3, 400),
                ("GKEEPER2", 2, 1_000),
                ("GKEEPER3", 1, 900),
            ]
        );

        let by_reward = leaderboard(&store, RankBy::Reward, None, 10)
            .await
            .expect("query");
        assert_eq!(
            by_reward
                .entries
                .iter()
                .map(|e| (e.keeper.as_str(), e.total_reward.0))
                .collect::<Vec<_>>(),
            vec![("GKEEPER2", 1_000), ("GKEEPER3", 900), ("GKEEPER1", 400)]
        );
    }

    #[tokio::test]
    async fn a_window_counts_only_executions_inside_it() {
        let store = store_with_executions(&[
            // Older than the window.
            ("GOLD", 10_000, 1_000),
            // Inside the window.
            ("GRECENT", 100, 5_000),
            ("GRECENT", 100, 5_100),
        ])
        .await;

        let windowed = leaderboard(&store, RankBy::Reward, Some(4_000), 10)
            .await
            .expect("query");

        // The big earner is outside the window, so it does not appear at all.
        assert_eq!(windowed.entries.len(), 1);
        assert_eq!(windowed.entries[0].keeper, "GRECENT");
        assert_eq!(windowed.entries[0].total_reward, I128(200));
        assert_eq!(windowed.since, Some(4_000));

        // All-time still sees both.
        let all_time = leaderboard(&store, RankBy::Reward, None, 10)
            .await
            .expect("query");
        assert_eq!(all_time.entries.len(), 2);
        assert_eq!(all_time.entries[0].keeper, "GOLD");
    }

    #[tokio::test]
    async fn a_window_boundary_is_inclusive() {
        let store = store_with_executions(&[("GKEEPER", 100, 5_000)]).await;

        let inclusive = leaderboard(&store, RankBy::Reward, Some(5_000), 10)
            .await
            .expect("query");
        assert_eq!(
            inclusive.entries.len(),
            1,
            "an execution exactly at the boundary counts"
        );

        let exclusive = leaderboard(&store, RankBy::Reward, Some(5_001), 10)
            .await
            .expect("query");
        assert!(exclusive.entries.is_empty());
    }

    #[tokio::test]
    async fn claims_and_withdrawals_do_not_count_as_work_done() {
        let store = Store::connect("sqlite::memory:").await.expect("store");

        store
            .insert_event(
                10,
                1_000,
                "tx-claim",
                0,
                &EventPayload::TaskClaimed {
                    task_id: 1,
                    keeper: "GKEEPER".into(),
                    claim_ledger: 10,
                },
            )
            .await
            .expect("insert");
        store
            .insert_event(
                11,
                1_100,
                "tx-wdraw",
                0,
                &EventPayload::RewardsWithdrawn {
                    keeper: "GKEEPER".into(),
                    amount: I128(9_999),
                },
            )
            .await
            .expect("insert");

        // A claim that never executed earned nothing and completed nothing;
        // a withdrawal moves already-earned money and is not new work.
        let board = leaderboard(&store, RankBy::Executions, None, 10)
            .await
            .expect("query");
        assert!(board.entries.is_empty());
    }

    #[test]
    fn rank_by_parses_its_wire_names() {
        assert_eq!(RankBy::parse("executions"), Some(RankBy::Executions));
        assert_eq!(RankBy::parse("reward"), Some(RankBy::Reward));
        assert_eq!(RankBy::parse("popularity"), None);
    }
}
