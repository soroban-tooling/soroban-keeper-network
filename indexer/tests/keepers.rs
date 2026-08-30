//! Keeper-facing ingestion and the derived balance (issue #349).

mod support;

use keeper_indexer::event::{Event, EventCursor, EventPayload};
use keeper_indexer::ingest::keepers::{keeper_activity, keeper_balance};
use keeper_indexer::ingest_all;

const KEEPER_A: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEEPER_B: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

fn claimed(ledger: u32, task_id: i64, keeper: &str) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 0),
        EventPayload::TaskClaimed {
            task_id,
            keeper: keeper.to_string(),
            claim_ledger: ledger,
        },
    )
}

fn executed(ledger: u32, task_id: i64, keeper: &str, net_reward: i128) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 1),
        EventPayload::TaskExecuted {
            task_id,
            keeper: keeper.to_string(),
            net_reward,
            proof: vec![0xab, 0xcd],
        },
    )
}

fn withdrawn(ledger: u32, keeper: &str, amount: i128) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 2),
        EventPayload::RewardsWithdrawn {
            keeper: keeper.to_string(),
            amount,
        },
    )
}

/// The acceptance-criterion-3 check: execute several tasks for one keeper,
/// withdraw partway through, and confirm the derived balance matches what the
/// contract's `keeper_balance` would return at each step.
///
/// The contract's model is `credit_keeper` on execute and a zeroing
/// `withdraw_rewards`, so the expected figure after each event is simply the
/// running sum of net rewards minus everything withdrawn so far. Asserting
/// after *every* event rather than only at the end is what makes this a
/// step-by-step agreement check rather than an end-state coincidence.
#[tokio::test]
async fn derived_balance_matches_the_contract_at_each_step() {
    let client = skip_without_db!();

    // (event, what the contract's keeper_balance would return afterwards)
    let steps: Vec<(Event, i128)> = vec![
        (claimed(10, 1, KEEPER_A), 0),
        (executed(11, 1, KEEPER_A, 400), 400),
        (claimed(12, 2, KEEPER_A), 400),
        (executed(13, 2, KEEPER_A, 600), 1_000),
        // withdraw_rewards zeroes the balance, so the amount is the full 1000
        (withdrawn(14, KEEPER_A, 1_000), 0),
        (claimed(15, 3, KEEPER_A), 0),
        (executed(16, 3, KEEPER_A, 250), 250),
    ];

    for (event, expected_balance) in &steps {
        ingest_all(&client, std::slice::from_ref(event))
            .await
            .expect("ingest failed");

        let balance = keeper_balance(&client, KEEPER_A).await.unwrap();
        assert_eq!(
            balance.available, *expected_balance,
            "balance disagreed with the contract after {:?}",
            event.payload
        );
    }

    // Lifetime totals stay distinguishable from the claimable balance.
    let balance = keeper_balance(&client, KEEPER_A).await.unwrap();
    assert_eq!(balance.credited_total, 1_250);
    assert_eq!(balance.withdrawn_total, 1_000);
    assert_eq!(balance.available, 250);
}

/// Querying by address returns that keeper's claims, executions and
/// withdrawals — and only that keeper's.
#[tokio::test]
async fn activity_is_scoped_to_one_keeper() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            claimed(10, 1, KEEPER_A),
            executed(11, 1, KEEPER_A, 400),
            withdrawn(12, KEEPER_A, 400),
            claimed(20, 2, KEEPER_B),
            executed(21, 2, KEEPER_B, 900),
        ],
    )
    .await
    .expect("ingest failed");

    let a = keeper_activity(&client, KEEPER_A).await.unwrap();
    assert_eq!(a.claims.len(), 1);
    assert_eq!(a.executions.len(), 1);
    assert_eq!(a.withdrawals.len(), 1);
    assert_eq!(a.claims[0].task_id, 1);
    assert_eq!(a.balance.available, 0);

    let b = keeper_activity(&client, KEEPER_B).await.unwrap();
    assert_eq!(b.claims.len(), 1);
    assert_eq!(b.executions.len(), 1);
    assert!(b.withdrawals.is_empty());
    assert_eq!(b.balance.available, 900);
    assert_eq!(b.balance.credited_total, 900);
}

/// An address the indexer has never seen is a zero balance, not an error —
/// matching what the contract's view returns for an unknown address.
#[tokio::test]
async fn unknown_keeper_has_a_zero_balance() {
    let client = skip_without_db!();

    let balance = keeper_balance(&client, KEEPER_A).await.unwrap();
    assert_eq!(balance.available, 0);
    assert_eq!(balance.credited_total, 0);
    assert_eq!(balance.withdrawn_total, 0);
}

/// Re-delivering the same event must not double-count it. The balance is a
/// `SUM`, so a duplicate execution row would silently inflate it — the exact
/// failure the cursor primary key exists to prevent.
#[tokio::test]
async fn re_ingesting_the_same_event_does_not_double_count() {
    let client = skip_without_db!();

    let events = vec![
        claimed(10, 1, KEEPER_A),
        executed(11, 1, KEEPER_A, 400),
        withdrawn(12, KEEPER_A, 100),
    ];

    ingest_all(&client, &events).await.expect("ingest failed");
    ingest_all(&client, &events)
        .await
        .expect("re-ingest failed");

    let activity = keeper_activity(&client, KEEPER_A).await.unwrap();
    assert_eq!(activity.claims.len(), 1);
    assert_eq!(activity.executions.len(), 1);
    assert_eq!(activity.withdrawals.len(), 1);
    assert_eq!(activity.balance.available, 300);
}

/// Rewards are `i128` on-chain; the text/NUMERIC bridge has to carry a value
/// far past what a 64-bit column could hold without losing precision.
#[tokio::test]
async fn large_i128_rewards_survive_the_round_trip() {
    let client = skip_without_db!();

    let big = i64::MAX as i128 * 1_000;
    ingest_all(&client, &[executed(11, 1, KEEPER_A, big)])
        .await
        .expect("ingest failed");

    let balance = keeper_balance(&client, KEEPER_A).await.unwrap();
    assert_eq!(balance.available, big);
}
