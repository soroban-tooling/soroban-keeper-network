//! Ingestion for keeper-facing events (issue #349).
//!
//! Handles `TaskClaimed`, `TaskExecuted`, and `RewardsWithdrawn`, and exposes
//! the per-keeper activity and derived-balance queries built on top of them.
//!
//! Every insert is `ON CONFLICT DO NOTHING` against the cursor primary key, so
//! replaying a ledger range that was already ingested is a no-op rather than a
//! duplicate row. That matters because the balance in [`keeper_balance`] is a
//! `SUM` — a double-inserted execution would silently inflate it, which is
//! exactly the kind of drift the contract-agreement check is meant to catch.

use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Apply one event to the keeper tables.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;
    match &event.payload {
        EventPayload::TaskClaimed {
            task_id,
            keeper,
            claim_ledger,
        } => {
            client
                .execute(
                    "INSERT INTO keeper_claims
                       (ledger, tx_index, event_index, keeper, task_id, claim_ledger)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        keeper,
                        task_id,
                        &(*claim_ledger as i64),
                    ],
                )
                .await?;
        }

        EventPayload::TaskExecuted {
            task_id,
            keeper,
            net_reward,
            proof,
        } => {
            client
                .execute(
                    "INSERT INTO keeper_executions
                       (ledger, tx_index, event_index, keeper, task_id, net_reward, proof)
                     VALUES ($1, $2, $3, $4, $5, $6::text::numeric, $7)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        keeper,
                        task_id,
                        &i128_to_sql(*net_reward),
                        proof,
                    ],
                )
                .await?;
        }

        EventPayload::RewardsWithdrawn { keeper, amount } => {
            client
                .execute(
                    "INSERT INTO keeper_withdrawals
                       (ledger, tx_index, event_index, keeper, amount)
                     VALUES ($1, $2, $3, $4, $5::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        keeper,
                        &i128_to_sql(*amount),
                    ],
                )
                .await?;
        }

        // Admin/governance events belong to `ingest::admin`.
        _ => {}
    }
    Ok(())
}

/// One task claim by a keeper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub task_id: i64,
    pub claim_ledger: u32,
    pub ledger: u32,
}

/// One task execution by a keeper, with the reward it was credited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Execution {
    pub task_id: i64,
    pub net_reward: i128,
    pub ledger: u32,
}

/// One withdrawal by a keeper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Withdrawal {
    pub amount: i128,
    pub ledger: u32,
}

/// Credited-versus-withdrawn totals for one keeper.
///
/// `available` is the figure that must agree with the contract's
/// `keeper_balance` view whenever the indexer is caught up. It is returned as
/// its own field rather than left to the caller to subtract — see acceptance
/// criterion 2 on issue #349.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeeperBalance {
    pub credited_total: i128,
    pub withdrawn_total: i128,
    pub available: i128,
}

/// Everything one keeper address has done.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeeperActivity {
    pub claims: Vec<Claim>,
    pub executions: Vec<Execution>,
    pub withdrawals: Vec<Withdrawal>,
    pub balance: KeeperBalance,
}

/// The derived credited-but-unwithdrawn balance for one keeper.
///
/// A keeper with no rows at all is not an error — it is a zero balance, which
/// is what the contract's view returns for an unknown address too.
pub async fn keeper_balance(client: &Client, keeper: &str) -> Result<KeeperBalance, IndexerError> {
    let row = client
        .query_opt(
            "SELECT credited_total::text, withdrawn_total::text, available_balance::text
               FROM keeper_balances
              WHERE keeper = $1",
            &[&keeper],
        )
        .await?;

    let Some(row) = row else {
        return Ok(KeeperBalance::default());
    };

    Ok(KeeperBalance {
        credited_total: i128_from_sql(row.get(0))?,
        withdrawn_total: i128_from_sql(row.get(1))?,
        available: i128_from_sql(row.get(2))?,
    })
}

/// Claims, executions, withdrawals and the derived balance for one keeper.
pub async fn keeper_activity(
    client: &Client,
    keeper: &str,
) -> Result<KeeperActivity, IndexerError> {
    let claim_rows = client
        .query(
            "SELECT task_id, claim_ledger, ledger
               FROM keeper_claims
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let exec_rows = client
        .query(
            "SELECT task_id, net_reward::text, ledger
               FROM keeper_executions
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let wd_rows = client
        .query(
            "SELECT amount::text, ledger
               FROM keeper_withdrawals
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let claims = claim_rows
        .iter()
        .map(|r| Claim {
            task_id: r.get::<_, i64>(0),
            claim_ledger: r.get::<_, i64>(1) as u32,
            ledger: r.get::<_, i64>(2) as u32,
        })
        .collect();

    let executions = exec_rows
        .iter()
        .map(|r| {
            Ok(Execution {
                task_id: r.get::<_, i64>(0),
                net_reward: i128_from_sql(r.get(1))?,
                ledger: r.get::<_, i64>(2) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    let withdrawals = wd_rows
        .iter()
        .map(|r| {
            Ok(Withdrawal {
                amount: i128_from_sql(r.get(0))?,
                ledger: r.get::<_, i64>(1) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    Ok(KeeperActivity {
        claims,
        executions,
        withdrawals,
        balance: keeper_balance(client, keeper).await?,
    })
}
