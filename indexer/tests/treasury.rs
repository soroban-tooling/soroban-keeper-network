//! Treasury ingestion, per-recipient distribution history, and the
//! total-distributed reconciliation check (acceptance criteria for the
//! treasury indexer work).

mod support;

use keeper_indexer::event::{Event, EventCursor, EventPayload};
use keeper_indexer::ingest::treasury::{recipient_activity, recipient_balance, total_distributed};
use keeper_indexer::ingest_all;

const RECIPIENT_A: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECIPIENT_B: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

fn added(ledger: u32, recipient: &str, shares_bps: u32) -> Event {
    added_at(ledger, 0, recipient, shares_bps)
}

/// Same as [`added`], with an explicit `event_index` — needed when two
/// recipients are added within the same ledger.
fn added_at(ledger: u32, event_index: u32, recipient: &str, shares_bps: u32) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, event_index),
        EventPayload::RecipientAdded {
            recipient: recipient.to_string(),
            shares_bps,
        },
    )
}

fn distributed(ledger: u32, recipient: &str, amount: i128, total_after: i128) -> Event {
    distributed_at(ledger, 1, recipient, amount, total_after)
}

/// Same as [`distributed`], with an explicit `event_index` — needed when two
/// `Distributed` events land in the same ledger (one `distribute` call
/// crediting several recipients), since the cursor's uniqueness is
/// `(ledger, tx_index, event_index)`.
fn distributed_at(
    ledger: u32,
    event_index: u32,
    recipient: &str,
    amount: i128,
    total_after: i128,
) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, event_index),
        EventPayload::Distributed {
            recipient: recipient.to_string(),
            amount,
            total_distributed: total_after,
        },
    )
}

fn withdrawn(ledger: u32, recipient: &str, amount: i128) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 2),
        EventPayload::TreasuryWithdrawn {
            recipient: recipient.to_string(),
            amount,
        },
    )
}

fn shares_updated(ledger: u32, recipient: &str, old_bps: u32, new_bps: u32) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 0),
        EventPayload::RecipientSharesUpdated {
            recipient: recipient.to_string(),
            old_shares_bps: old_bps,
            new_shares_bps: new_bps,
        },
    )
}

fn removed(ledger: u32, recipient: &str) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 0),
        EventPayload::RecipientRemoved {
            recipient: recipient.to_string(),
        },
    )
}

/// The acceptance-criterion check: the derived per-recipient balance must
/// agree with what the contract's `recipient_balance` view would return at
/// each step, mirroring `keepers.rs`'s
/// `derived_balance_matches_the_contract_at_each_step`.
#[tokio::test]
async fn derived_balance_matches_the_contract_at_each_step() {
    let client = skip_without_db!();

    let steps: Vec<(Event, i128)> = vec![
        (added(10, RECIPIENT_A, 5_000), 0),
        (distributed(11, RECIPIENT_A, 400, 400), 400),
        (distributed(12, RECIPIENT_A, 600, 1_000), 1_000),
        // withdraw zeroes the balance, so the amount is the full 1000.
        (withdrawn(13, RECIPIENT_A, 1_000), 0),
        (distributed(14, RECIPIENT_A, 250, 1_250), 250),
    ];

    for (event, expected_balance) in &steps {
        ingest_all(&client, std::slice::from_ref(event))
            .await
            .expect("ingest failed");

        let balance = recipient_balance(&client, RECIPIENT_A).await.unwrap();
        assert_eq!(
            balance.available, *expected_balance,
            "balance disagreed with the contract after {:?}",
            event.payload
        );
    }

    let balance = recipient_balance(&client, RECIPIENT_A).await.unwrap();
    assert_eq!(balance.credited_total, 1_250);
    assert_eq!(balance.withdrawn_total, 1_000);
    assert_eq!(balance.available, 250);
}

/// Querying by address returns that recipient's distributions and
/// withdrawals — and only that recipient's.
#[tokio::test]
async fn activity_is_scoped_to_one_recipient() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            added(10, RECIPIENT_A, 5_000),
            added_at(10, 1, RECIPIENT_B, 5_000),
            distributed(11, RECIPIENT_A, 400, 400),
            withdrawn(12, RECIPIENT_A, 400),
            distributed(20, RECIPIENT_B, 900, 900),
        ],
    )
    .await
    .expect("ingest failed");

    let a = recipient_activity(&client, RECIPIENT_A).await.unwrap();
    assert_eq!(a.distributions.len(), 1);
    assert_eq!(a.withdrawals.len(), 1);
    assert_eq!(a.balance.available, 0);

    let b = recipient_activity(&client, RECIPIENT_B).await.unwrap();
    assert_eq!(b.distributions.len(), 1);
    assert!(b.withdrawals.is_empty());
    assert_eq!(b.balance.available, 900);
    assert_eq!(b.balance.credited_total, 900);
}

/// An address the indexer has never seen is a zero balance, not an error.
#[tokio::test]
async fn unknown_recipient_has_a_zero_balance() {
    let client = skip_without_db!();

    let balance = recipient_balance(&client, RECIPIENT_A).await.unwrap();
    assert_eq!(balance.available, 0);
    assert_eq!(balance.credited_total, 0);
    assert_eq!(balance.withdrawn_total, 0);
}

/// Re-delivering the same event must not double-count it — the balance and
/// the total-distributed reconciliation are both `SUM`s.
#[tokio::test]
async fn re_ingesting_the_same_event_does_not_double_count() {
    let client = skip_without_db!();

    let events = vec![
        added(10, RECIPIENT_A, 5_000),
        distributed(11, RECIPIENT_A, 400, 400),
        withdrawn(12, RECIPIENT_A, 100),
    ];

    ingest_all(&client, &events).await.expect("ingest failed");
    ingest_all(&client, &events)
        .await
        .expect("re-ingest failed");

    let activity = recipient_activity(&client, RECIPIENT_A).await.unwrap();
    assert_eq!(activity.distributions.len(), 1);
    assert_eq!(activity.withdrawals.len(), 1);
    assert_eq!(activity.balance.available, 300);
    assert_eq!(total_distributed(&client).await.unwrap(), 400);
}

/// Acceptance criterion 3: the indexer's independently-summed total must
/// align with the contract's own running `TotalDistributed` figure across
/// several recipients, once fully synchronized.
#[tokio::test]
async fn total_distributed_matches_the_contract_running_total() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            added(10, RECIPIENT_A, 5_000),
            added_at(10, 1, RECIPIENT_B, 5_000),
            distributed_at(11, 1, RECIPIENT_A, 300, 300),
            distributed_at(11, 2, RECIPIENT_B, 700, 1_000),
            distributed(20, RECIPIENT_A, 150, 1_150),
        ],
    )
    .await
    .expect("ingest failed");

    // Sum of every credited amount, independent of the contract's own
    // running-total field.
    assert_eq!(total_distributed(&client).await.unwrap(), 1_150);

    // And it must agree with the contract's own reported running total as of
    // the last event.
    let a = recipient_activity(&client, RECIPIENT_A).await.unwrap();
    let last = a.distributions.last().unwrap();
    assert_eq!(last.total_distributed_after, 1_150);
}

/// A recipient's current share reflects the latest `added`/`shares_updated`
/// event, and a `removed` recipient drops out of the active set — the
/// derived-current-state property `current_config` establishes for the
/// admin schema, applied to recipients.
#[tokio::test]
async fn current_recipient_set_reflects_the_latest_event() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            added(10, RECIPIENT_A, 5_000),
            shares_updated(11, RECIPIENT_A, 5_000, 7_500),
            added_at(10, 1, RECIPIENT_B, 2_500),
            removed(12, RECIPIENT_B),
        ],
    )
    .await
    .expect("ingest failed");

    let rows = client
        .query(
            "SELECT recipient, shares_bps FROM treasury_current_recipients_active ORDER BY recipient",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1, "only the non-removed recipient is active");
    assert_eq!(rows[0].get::<_, String>(0), RECIPIENT_A);
    assert_eq!(rows[0].get::<_, i32>(1), 7_500);
}
