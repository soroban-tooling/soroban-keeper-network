//! Ingestion for keeper staking events (epic E06, issue 0296 / GitHub #432).
//!
//! Handles `StakeDeposited`, `UnbondInitiated`, `StakeWithdrawn`, and
//! `Slashed`, and exposes the derived current-stake query built on top of
//! them, following the same history-plus-derived-current-state pattern
//! `ingest::keepers` established for keeper balances (issue #349).
//!
//! Every insert is `ON CONFLICT DO NOTHING` against the cursor primary key,
//! so replaying an already-ingested ledger range is a no-op rather than a
//! duplicate row — the same reason it matters in `ingest::keepers`: the
//! stake total in [`keeper_stake`] is a `SUM`.

use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Apply one event to the staking tables.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;
    match &event.payload {
        EventPayload::StakeDeposited {
            keeper,
            amount,
            new_total,
        } => {
            client
                .execute(
                    "INSERT INTO keeper_stake_deposits
                       (ledger, tx_index, event_index, keeper, amount, new_total)
                     VALUES ($1, $2, $3, $4, $5::text::numeric, $6::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        keeper,
                        &i128_to_sql(*amount),
                        &i128_to_sql(*new_total),
                    ],
                )
                .await?;
        }

        EventPayload::UnbondInitiated {
            keeper,
            amount,
            release_ledger,
        } => {
            client
                .execute(
                    "INSERT INTO keeper_unbonds
                       (ledger, tx_index, event_index, keeper, amount, release_ledger)
                     VALUES ($1, $2, $3, $4, $5::text::numeric, $6)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        keeper,
                        &i128_to_sql(*amount),
                        &(*release_ledger as i64),
                    ],
                )
                .await?;
        }

        EventPayload::StakeWithdrawn { keeper, amount } => {
            client
                .execute(
                    "INSERT INTO keeper_stake_withdrawals
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

        EventPayload::Slashed {
            keeper,
            amount,
            reason,
            incident_id,
            treasury,
        } => {
            client
                .execute(
                    "INSERT INTO keeper_slashes
                       (ledger, tx_index, event_index, keeper, amount, reason, incident_id, treasury)
                     VALUES ($1, $2, $3, $4, $5::text::numeric, $6, $7, $8)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        keeper,
                        &i128_to_sql(*amount),
                        reason,
                        &incident_id.as_slice(),
                        treasury,
                    ],
                )
                .await?;
        }

        // Task lifecycle, keeper-reward and admin/governance events belong to
        // `ingest::tasks`, `ingest::keepers`, and `ingest::admin`.
        _ => {}
    }
    Ok(())
}

/// One stake deposit by a keeper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StakeDeposit {
    pub amount: i128,
    pub new_total: i128,
    pub ledger: u32,
}

/// One unbond request initiated by a keeper. Kept for the audit trail only —
/// it does not contribute to [`KeeperStake`], matching the contract (the
/// stake stays escrowed until `withdraw_stake` actually releases it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnbondRequest {
    pub amount: i128,
    pub release_ledger: u32,
    pub ledger: u32,
}

/// One stake withdrawal by a keeper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StakeWithdrawal {
    pub amount: i128,
    pub ledger: u32,
}

/// One slash against a keeper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slash {
    pub amount: i128,
    pub reason: String,
    pub incident_id: [u8; 32],
    pub treasury: String,
    pub ledger: u32,
}

/// Deposited-versus-withdrawn-versus-slashed totals for one keeper.
///
/// `current_stake` is the figure that must agree with the contract's
/// `keeper_stake` view whenever the indexer is caught up, matching the
/// precedent `KeeperBalance::available` set for keeper rewards (issue #349).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeeperStake {
    pub deposited_total: i128,
    pub withdrawn_total: i128,
    pub slashed_total: i128,
    pub current_stake: i128,
}

/// Everything one keeper address has done with staking.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StakingActivity {
    pub deposits: Vec<StakeDeposit>,
    pub unbonds: Vec<UnbondRequest>,
    pub withdrawals: Vec<StakeWithdrawal>,
    pub slashes: Vec<Slash>,
    pub stake: KeeperStake,
}

/// The derived current stake for one keeper.
///
/// A keeper with no rows at all is not an error — it is a zero stake, which
/// is what the contract's `keeper_stake` view returns for an unknown address
/// too (staking.rs's `keeper_stake`, backed by `read_keeper_stake`'s
/// `unwrap_or(0)`).
pub async fn keeper_stake(client: &Client, keeper: &str) -> Result<KeeperStake, IndexerError> {
    let row = client
        .query_opt(
            "SELECT deposited_total::text, withdrawn_total::text, slashed_total::text, current_stake::text
               FROM keeper_stakes
              WHERE keeper = $1",
            &[&keeper],
        )
        .await?;

    let Some(row) = row else {
        return Ok(KeeperStake::default());
    };

    Ok(KeeperStake {
        deposited_total: i128_from_sql(row.get(0))?,
        withdrawn_total: i128_from_sql(row.get(1))?,
        slashed_total: i128_from_sql(row.get(2))?,
        current_stake: i128_from_sql(row.get(3))?,
    })
}

/// Deposits, unbonds, withdrawals, slashes and the derived stake for one
/// keeper.
pub async fn staking_activity(
    client: &Client,
    keeper: &str,
) -> Result<StakingActivity, IndexerError> {
    let deposit_rows = client
        .query(
            "SELECT amount::text, new_total::text, ledger
               FROM keeper_stake_deposits
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let unbond_rows = client
        .query(
            "SELECT amount::text, release_ledger, ledger
               FROM keeper_unbonds
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let withdrawal_rows = client
        .query(
            "SELECT amount::text, ledger
               FROM keeper_stake_withdrawals
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let slash_rows = client
        .query(
            "SELECT amount::text, reason, incident_id, treasury, ledger
               FROM keeper_slashes
              WHERE keeper = $1
              ORDER BY ledger, tx_index, event_index",
            &[&keeper],
        )
        .await?;

    let deposits = deposit_rows
        .iter()
        .map(|r| {
            Ok(StakeDeposit {
                amount: i128_from_sql(r.get(0))?,
                new_total: i128_from_sql(r.get(1))?,
                ledger: r.get::<_, i64>(2) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    let unbonds = unbond_rows
        .iter()
        .map(|r| {
            Ok(UnbondRequest {
                amount: i128_from_sql(r.get(0))?,
                release_ledger: r.get::<_, i64>(1) as u32,
                ledger: r.get::<_, i64>(2) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    let withdrawals = withdrawal_rows
        .iter()
        .map(|r| {
            Ok(StakeWithdrawal {
                amount: i128_from_sql(r.get(0))?,
                ledger: r.get::<_, i64>(1) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    let slashes = slash_rows
        .iter()
        .map(|r| {
            let incident_id: Vec<u8> = r.get(2);
            let mut id = [0u8; 32];
            id.copy_from_slice(&incident_id);
            Ok(Slash {
                amount: i128_from_sql(r.get(0))?,
                reason: r.get(1),
                incident_id: id,
                treasury: r.get(3),
                ledger: r.get::<_, i64>(4) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    Ok(StakingActivity {
        deposits,
        unbonds,
        withdrawals,
        slashes,
        stake: keeper_stake(client, keeper).await?,
    })
}
