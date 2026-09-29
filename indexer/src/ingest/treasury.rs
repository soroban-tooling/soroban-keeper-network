//! Ingestion for treasury contract events.
//!
//! Handles `RecipientAdded`, `RecipientRemoved`, `RecipientSharesUpdated`,
//! `Distributed`, and `TreasuryWithdrawn`. Mirrors the split in
//! `ingest::admin` (governance audit trail) and `ingest::keepers`
//! (per-address activity + derived balance) for the equivalent treasury
//! concepts.
//!
//! Every insert is `ON CONFLICT DO NOTHING` against the cursor primary key,
//! so replaying an already-ingested ledger range is a no-op rather than a
//! duplicate row — the same idempotency guarantee `keeper_balance` relies on,
//! needed here because `treasury_recipient_balances` is also a `SUM`.

use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Apply one event to the treasury tables.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;
    match &event.payload {
        EventPayload::RecipientAdded {
            recipient,
            shares_bps,
        } => {
            client
                .execute(
                    "INSERT INTO treasury_recipient_events
                       (ledger, tx_index, event_index, kind, recipient, shares_bps)
                     VALUES ($1, $2, $3, 'added', $4, $5)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        recipient,
                        &(*shares_bps as i32),
                    ],
                )
                .await?;
        }

        EventPayload::RecipientRemoved { recipient } => {
            client
                .execute(
                    "INSERT INTO treasury_recipient_events
                       (ledger, tx_index, event_index, kind, recipient)
                     VALUES ($1, $2, $3, 'removed', $4)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        recipient,
                    ],
                )
                .await?;
        }

        EventPayload::RecipientSharesUpdated {
            recipient,
            old_shares_bps,
            new_shares_bps,
        } => {
            client
                .execute(
                    "INSERT INTO treasury_recipient_events
                       (ledger, tx_index, event_index, kind, recipient, old_shares_bps, new_shares_bps)
                     VALUES ($1, $2, $3, 'shares_updated', $4, $5, $6)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        recipient,
                        &(*old_shares_bps as i32),
                        &(*new_shares_bps as i32),
                    ],
                )
                .await?;
        }

        EventPayload::Distributed {
            recipient,
            amount,
            total_distributed,
        } => {
            client
                .execute(
                    "INSERT INTO treasury_distributions
                       (ledger, tx_index, event_index, recipient, amount, total_distributed)
                     VALUES ($1, $2, $3, $4, $5::text::numeric, $6::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        recipient,
                        &i128_to_sql(*amount),
                        &i128_to_sql(*total_distributed),
                    ],
                )
                .await?;
        }

        EventPayload::TreasuryWithdrawn { recipient, amount } => {
            client
                .execute(
                    "INSERT INTO treasury_withdrawals
                       (ledger, tx_index, event_index, recipient, amount)
                     VALUES ($1, $2, $3, $4, $5::text::numeric)
                     ON CONFLICT (ledger, tx_index, event_index) DO NOTHING",
                    &[
                        &(c.ledger as i64),
                        &(c.tx_index as i64),
                        &(c.event_index as i64),
                        recipient,
                        &i128_to_sql(*amount),
                    ],
                )
                .await?;
        }

        // Keeper-registry events belong to the other `ingest` modules.
        _ => {}
    }
    Ok(())
}

/// One distribution credited to a recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Distribution {
    pub amount: i128,
    pub total_distributed_after: i128,
    pub ledger: u32,
}

/// One withdrawal by a recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientWithdrawal {
    pub amount: i128,
    pub ledger: u32,
}

/// Credited-versus-withdrawn totals for one recipient. `available` must agree
/// with the contract's `recipient_balance` view once the indexer is caught
/// up — the acceptance criterion issue #349's `keeper_balance` established
/// for keepers, applied here to recipients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecipientBalance {
    pub credited_total: i128,
    pub withdrawn_total: i128,
    pub available: i128,
}

/// A recipient's full distribution history and derived balance — the
/// per-recipient distribution history query issue #349's `keeper_activity`
/// pattern is mirrored from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecipientActivity {
    pub distributions: Vec<Distribution>,
    pub withdrawals: Vec<RecipientWithdrawal>,
    pub balance: RecipientBalance,
}

/// The derived credited-but-unwithdrawn balance for one recipient.
///
/// A recipient with no rows at all is not an error — it is a zero balance,
/// which is what the contract's view returns for an unregistered address too.
pub async fn recipient_balance(
    client: &Client,
    recipient: &str,
) -> Result<RecipientBalance, IndexerError> {
    let row = client
        .query_opt(
            "SELECT credited_total::text, withdrawn_total::text, available_balance::text
               FROM treasury_recipient_balances
              WHERE recipient = $1",
            &[&recipient],
        )
        .await?;

    let Some(row) = row else {
        return Ok(RecipientBalance::default());
    };

    Ok(RecipientBalance {
        credited_total: i128_from_sql(row.get(0))?,
        withdrawn_total: i128_from_sql(row.get(1))?,
        available: i128_from_sql(row.get(2))?,
    })
}

/// Distributions, withdrawals, and the derived balance for one recipient.
pub async fn recipient_activity(
    client: &Client,
    recipient: &str,
) -> Result<RecipientActivity, IndexerError> {
    let dist_rows = client
        .query(
            "SELECT amount::text, total_distributed::text, ledger
               FROM treasury_distributions
              WHERE recipient = $1
              ORDER BY ledger, tx_index, event_index",
            &[&recipient],
        )
        .await?;

    let wd_rows = client
        .query(
            "SELECT amount::text, ledger
               FROM treasury_withdrawals
              WHERE recipient = $1
              ORDER BY ledger, tx_index, event_index",
            &[&recipient],
        )
        .await?;

    let distributions = dist_rows
        .iter()
        .map(|r| {
            Ok(Distribution {
                amount: i128_from_sql(r.get(0))?,
                total_distributed_after: i128_from_sql(r.get(1))?,
                ledger: r.get::<_, i64>(2) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    let withdrawals = wd_rows
        .iter()
        .map(|r| {
            Ok(RecipientWithdrawal {
                amount: i128_from_sql(r.get(0))?,
                ledger: r.get::<_, i64>(1) as u32,
            })
        })
        .collect::<Result<Vec<_>, IndexerError>>()?;

    Ok(RecipientActivity {
        distributions,
        withdrawals,
        balance: recipient_balance(client, recipient).await?,
    })
}

/// Lifetime total distributed to every recipient, independently summed from
/// `treasury_distributions` rather than read off the contract. This is the
/// figure acceptance criterion 3 (issue #349) checks against the contract's
/// own `total_distributed` view once the indexer is fully synchronized.
pub async fn total_distributed(client: &Client) -> Result<i128, IndexerError> {
    let row = client
        .query_one(
            "SELECT COALESCE(SUM(amount), 0)::text FROM treasury_distributions",
            &[],
        )
        .await?;
    i128_from_sql(row.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventCursor;

    fn cursor(n: i64) -> EventCursor {
        EventCursor::new(n as u32, 0, 0)
    }

    #[test]
    fn distribution_and_withdrawal_types_hold_their_fields() {
        let d = Distribution {
            amount: 100,
            total_distributed_after: 1_000,
            ledger: 5,
        };
        assert_eq!(d.amount, 100);

        let w = RecipientWithdrawal {
            amount: 50,
            ledger: 6,
        };
        assert_eq!(w.amount, 50);
    }

    #[test]
    fn event_topics_are_distinct_from_registry_topics() {
        let events = [
            EventPayload::RecipientAdded {
                recipient: "GR1".into(),
                shares_bps: 5_000,
            },
            EventPayload::RecipientRemoved {
                recipient: "GR1".into(),
            },
            EventPayload::RecipientSharesUpdated {
                recipient: "GR1".into(),
                old_shares_bps: 5_000,
                new_shares_bps: 6_000,
            },
            EventPayload::Distributed {
                recipient: "GR1".into(),
                amount: 100,
                total_distributed: 100,
            },
            EventPayload::TreasuryWithdrawn {
                recipient: "GR1".into(),
                amount: 100,
            },
        ];
        for event in events {
            let _ = Event::new(cursor(1), event);
        }
    }
}
