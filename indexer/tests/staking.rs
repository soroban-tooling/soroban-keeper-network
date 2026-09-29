//! Keeper staking ingestion and the derived stake (epic E06, issue 0296 /
//! GitHub #432).

mod support;

use keeper_indexer::event::{Event, EventCursor, EventPayload};
use keeper_indexer::ingest::staking::{keeper_stake, staking_activity};
use keeper_indexer::ingest_all;

const KEEPER_A: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEEPER_B: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TREASURY: &str = "GTREASURYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn deposited(ledger: u32, keeper: &str, amount: i128, new_total: i128) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 0),
        EventPayload::StakeDeposited {
            keeper: keeper.to_string(),
            amount,
            new_total,
        },
    )
}

fn unbonded(ledger: u32, keeper: &str, amount: i128, release_ledger: u32) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 1),
        EventPayload::UnbondInitiated {
            keeper: keeper.to_string(),
            amount,
            release_ledger,
        },
    )
}

fn withdrawn(ledger: u32, keeper: &str, amount: i128) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 2),
        EventPayload::StakeWithdrawn {
            keeper: keeper.to_string(),
            amount,
        },
    )
}

fn slashed(ledger: u32, keeper: &str, amount: i128, incident: u8) -> Event {
    Event::new(
        EventCursor::new(ledger, 0, 3),
        EventPayload::Slashed {
            keeper: keeper.to_string(),
            amount,
            reason: "misbehav".to_string(),
            incident_id: [incident; 32],
            treasury: TREASURY.to_string(),
        },
    )
}

/// The correctness check issue #432 asks for, following the same shape issue
/// #349 established for keeper balances: replay a mixed sequence and confirm
/// the derived stake matches what the contract's `keeper_stake` view would
/// return after every event, not just at the end.
#[tokio::test]
async fn derived_stake_matches_the_contract_at_each_step() {
    let client = skip_without_db!();

    // (event, what the contract's keeper_stake would return afterwards)
    let steps: Vec<(Event, i128)> = vec![
        (deposited(10, KEEPER_A, 1_000, 1_000), 1_000),
        (deposited(11, KEEPER_A, 500, 1_500), 1_500),
        // initiate_unbond never changes keeper_stake — the amount stays
        // escrowed (and slashable) until withdraw_stake actually releases it.
        (unbonded(12, KEEPER_A, 300, 100_012), 1_500),
        (withdrawn(13, KEEPER_A, 300), 1_200),
        (slashed(14, KEEPER_A, 200, 1), 1_000),
        (deposited(15, KEEPER_A, 100, 1_100), 1_100),
        (slashed(16, KEEPER_A, 50, 2), 1_050),
    ];

    for (event, expected_stake) in &steps {
        ingest_all(&client, std::slice::from_ref(event))
            .await
            .expect("ingest failed");

        let stake = keeper_stake(&client, KEEPER_A).await.unwrap();
        assert_eq!(
            stake.current_stake, *expected_stake,
            "stake disagreed with the contract after {:?}",
            event.payload
        );
    }

    // Lifetime totals stay distinguishable from the current stake.
    let stake = keeper_stake(&client, KEEPER_A).await.unwrap();
    assert_eq!(stake.deposited_total, 1_600);
    assert_eq!(stake.withdrawn_total, 300);
    assert_eq!(stake.slashed_total, 250);
    assert_eq!(stake.current_stake, 1_050);
}

/// Querying by address returns that keeper's deposits, unbonds, withdrawals
/// and slashes — and only that keeper's.
#[tokio::test]
async fn staking_activity_is_scoped_to_one_keeper() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            deposited(10, KEEPER_A, 1_000, 1_000),
            unbonded(11, KEEPER_A, 200, 100_011),
            withdrawn(12, KEEPER_A, 200),
            deposited(20, KEEPER_B, 500, 500),
            slashed(21, KEEPER_B, 100, 9),
        ],
    )
    .await
    .expect("ingest failed");

    let a = staking_activity(&client, KEEPER_A).await.unwrap();
    assert_eq!(a.deposits.len(), 1);
    assert_eq!(a.unbonds.len(), 1);
    assert_eq!(a.withdrawals.len(), 1);
    assert!(a.slashes.is_empty());
    assert_eq!(a.stake.current_stake, 800);

    let b = staking_activity(&client, KEEPER_B).await.unwrap();
    assert_eq!(b.deposits.len(), 1);
    assert!(b.unbonds.is_empty());
    assert!(b.withdrawals.is_empty());
    assert_eq!(b.slashes.len(), 1);
    assert_eq!(b.slashes[0].reason, "misbehav");
    assert_eq!(b.slashes[0].treasury, TREASURY);
    assert_eq!(b.stake.current_stake, 400);
}

/// An address the indexer has never seen is a zero stake, not an error —
/// matching what the contract's view returns for an unknown address.
#[tokio::test]
async fn unknown_keeper_has_a_zero_stake() {
    let client = skip_without_db!();

    let stake = keeper_stake(&client, KEEPER_A).await.unwrap();
    assert_eq!(stake.current_stake, 0);
    assert_eq!(stake.deposited_total, 0);
    assert_eq!(stake.withdrawn_total, 0);
    assert_eq!(stake.slashed_total, 0);
}

/// Re-delivering the same event must not double-count it. The stake is a
/// `SUM`, so a duplicate deposit or slash row would silently inflate or
/// deflate it — the exact failure the cursor primary key exists to prevent.
#[tokio::test]
async fn re_ingesting_the_same_event_does_not_double_count() {
    let client = skip_without_db!();

    let events = vec![
        deposited(10, KEEPER_A, 1_000, 1_000),
        withdrawn(11, KEEPER_A, 100),
        slashed(12, KEEPER_A, 50, 3),
    ];

    ingest_all(&client, &events).await.expect("ingest failed");
    ingest_all(&client, &events)
        .await
        .expect("re-ingest failed");

    let activity = staking_activity(&client, KEEPER_A).await.unwrap();
    assert_eq!(activity.deposits.len(), 1);
    assert_eq!(activity.withdrawals.len(), 1);
    assert_eq!(activity.slashes.len(), 1);
    assert_eq!(activity.stake.current_stake, 850);
}

/// Stake amounts are `i128` on-chain; the text/NUMERIC bridge has to carry a
/// value far past what a 64-bit column could hold without losing precision.
#[tokio::test]
async fn large_i128_stake_amounts_survive_the_round_trip() {
    let client = skip_without_db!();

    let big = i64::MAX as i128 * 1_000;
    ingest_all(&client, &[deposited(11, KEEPER_A, big, big)])
        .await
        .expect("ingest failed");

    let stake = keeper_stake(&client, KEEPER_A).await.unwrap();
    assert_eq!(stake.current_stake, big);
}

/// The 32-byte `incident_id` must round-trip byte-for-byte through the
/// `BYTEA` column, matching the contract's own incident-level idempotency.
#[tokio::test]
async fn slash_incident_id_round_trips_exactly() {
    let client = skip_without_db!();

    ingest_all(&client, &[deposited(10, KEEPER_A, 1_000, 1_000)])
        .await
        .expect("ingest failed");
    ingest_all(&client, &[slashed(11, KEEPER_A, 100, 0xab)])
        .await
        .expect("ingest failed");

    let activity = staking_activity(&client, KEEPER_A).await.unwrap();
    assert_eq!(activity.slashes.len(), 1);
    assert_eq!(activity.slashes[0].incident_id, [0xabu8; 32]);
}
