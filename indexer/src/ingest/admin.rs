//! Ingestion for admin and governance-adjacent events (issue #350).
//!
//! Handles all seven of `Paused`, `FeeUpdated`, `AdminTransferred`,
//! `MinRewardUpdated`, `FeesSwept`, `Initialized` and `Upgraded`.
//!
//! Every event becomes its own immutable row in `admin_events`; nothing is ever
//! updated in place. A second `FeeUpdated` does not overwrite the first — it
//! appends, and the current fee is whatever the newest row says. That is what
//! keeps the audit trail complete while still making "what is the fee right
//! now" a single cheap query against `current_config`.

use tokio_postgres::Client;

use crate::event::{Event, EventPayload};
use crate::numeric::{i128_from_sql, i128_to_sql};
use crate::IndexerError;

/// Column list shared by every insert below. The unused columns bind NULL,
/// which the `admin_events_payload_present` constraint validates per kind.
const INSERT_SQL: &str = "
    INSERT INTO admin_events (
        ledger, tx_index, event_index, kind,
        paused, old_fee_bps, new_fee_bps,
        old_admin, new_admin, treasury, reward_token,
        old_min_reward, new_min_reward,
        swept_amount, swept_remaining, wasm_hash
    ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12::text::numeric, $13::text::numeric,
        $14::text::numeric, $15::text::numeric, $16
    )
    ON CONFLICT (ledger, tx_index, event_index) DO NOTHING";

/// Apply one event to `admin_events`.
///
/// Events this module does not own are ignored, so a caller can hand it the
/// whole stream without pre-filtering.
pub async fn ingest_event(client: &Client, event: &Event) -> Result<(), IndexerError> {
    let c = &event.cursor;

    // Everything a row might carry; each arm fills in only its own fields.
    let kind: &str;
    let mut paused: Option<bool> = None;
    let mut old_fee_bps: Option<i32> = None;
    let mut new_fee_bps: Option<i32> = None;
    let mut old_admin: Option<String> = None;
    let mut new_admin: Option<String> = None;
    let mut treasury: Option<String> = None;
    let mut reward_token: Option<String> = None;
    let mut old_min_reward: Option<String> = None;
    let mut new_min_reward: Option<String> = None;
    let mut swept_amount: Option<String> = None;
    let mut swept_remaining: Option<String> = None;
    let mut wasm_hash: Option<Vec<u8>> = None;

    match &event.payload {
        EventPayload::Paused { paused: p } => {
            kind = "paused";
            paused = Some(*p);
        }
        EventPayload::FeeUpdated { old_bps, new_bps } => {
            kind = "fee_updated";
            old_fee_bps = Some(*old_bps);
            new_fee_bps = Some(*new_bps);
        }
        EventPayload::AdminTransferred {
            old_admin: old,
            new_admin: new,
        } => {
            kind = "admin_transferred";
            old_admin = Some(old.clone());
            new_admin = Some(new.clone());
        }
        EventPayload::MinRewardUpdated { old_min, new_min } => {
            kind = "min_reward_updated";
            old_min_reward = Some(i128_to_sql(*old_min));
            new_min_reward = Some(i128_to_sql(*new_min));
        }
        EventPayload::FeesSwept {
            treasury: t,
            amount,
            remaining,
        } => {
            kind = "fees_swept";
            treasury = Some(t.clone());
            swept_amount = Some(i128_to_sql(*amount));
            swept_remaining = Some(i128_to_sql(*remaining));
        }
        EventPayload::Initialized {
            admin,
            reward_token: token,
            fee_bps,
        } => {
            kind = "initialized";
            // Initialized sets the first admin and the first fee; there is no
            // prior value, so the `old_*` columns stay NULL rather than being
            // faked as zero.
            new_admin = Some(admin.clone());
            reward_token = Some(token.clone());
            new_fee_bps = Some(*fee_bps);
        }
        EventPayload::Upgraded {
            admin,
            new_wasm_hash,
        } => {
            kind = "upgraded";
            new_admin = Some(admin.clone());
            wasm_hash = Some(new_wasm_hash.to_vec());
        }

        // Keeper-facing events belong to `ingest::keepers`.
        _ => return Ok(()),
    }

    client
        .execute(
            INSERT_SQL,
            &[
                &(c.ledger as i64),
                &(c.tx_index as i64),
                &(c.event_index as i64),
                &kind,
                &paused,
                &old_fee_bps,
                &new_fee_bps,
                &old_admin,
                &new_admin,
                &treasury,
                &reward_token,
                &old_min_reward,
                &new_min_reward,
                &swept_amount,
                &swept_remaining,
                &wasm_hash,
            ],
        )
        .await?;

    Ok(())
}

/// The configuration currently in force, derived from the latest event of each
/// kind.
///
/// Fields are `Option` where the contract has no default: before an
/// `Initialized` event has been seen there is genuinely no admin or fee, and
/// reporting `None` is more honest than inventing a zero. `paused` and
/// `min_reward` do have contract defaults (false and 0), so they are not
/// optional.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CurrentConfig {
    pub fee_bps: Option<i32>,
    pub admin: Option<String>,
    pub paused: bool,
    pub min_reward: i128,
    pub reward_token: Option<String>,
    pub current_wasm_hash: Option<Vec<u8>>,
}

/// Read the derived current configuration.
pub async fn current_config(client: &Client) -> Result<CurrentConfig, IndexerError> {
    let row = client
        .query_one(
            "SELECT fee_bps, admin, paused, min_reward::text, reward_token, current_wasm_hash
               FROM current_config",
            &[],
        )
        .await?;

    Ok(CurrentConfig {
        fee_bps: row.get(0),
        admin: row.get(1),
        paused: row.get(2),
        min_reward: i128_from_sql(row.get(3))?,
        reward_token: row.get(4),
        current_wasm_hash: row.get(5),
    })
}

/// One row of the governance audit trail, in chain order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminEventRow {
    pub ledger: u32,
    pub kind: String,
    pub old_fee_bps: Option<i32>,
    pub new_fee_bps: Option<i32>,
    pub old_admin: Option<String>,
    pub new_admin: Option<String>,
    pub paused: Option<bool>,
    pub wasm_hash: Option<Vec<u8>>,
}

/// The full history, oldest first. Passing `kind` restricts it to one event
/// kind — "every fee change, in order" is the query this exists for.
pub async fn admin_history(
    client: &Client,
    kind: Option<&str>,
) -> Result<Vec<AdminEventRow>, IndexerError> {
    let rows = match kind {
        Some(k) => {
            client
                .query(
                    "SELECT ledger, kind, old_fee_bps, new_fee_bps, old_admin, new_admin,
                            paused, wasm_hash
                       FROM admin_events
                      WHERE kind = $1
                      ORDER BY ledger, tx_index, event_index",
                    &[&k],
                )
                .await?
        }
        None => {
            client
                .query(
                    "SELECT ledger, kind, old_fee_bps, new_fee_bps, old_admin, new_admin,
                            paused, wasm_hash
                       FROM admin_events
                      ORDER BY ledger, tx_index, event_index",
                    &[],
                )
                .await?
        }
    };

    Ok(rows
        .iter()
        .map(|r| AdminEventRow {
            ledger: r.get::<_, i64>(0) as u32,
            kind: r.get(1),
            old_fee_bps: r.get(2),
            new_fee_bps: r.get(3),
            old_admin: r.get(4),
            new_admin: r.get(5),
            paused: r.get(6),
            wasm_hash: r.get(7),
        })
        .collect())
}
