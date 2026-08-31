//! Admin and governance ingestion, history, and derived config (issue #350).

mod support;

use keeper_indexer::event::{Event, EventCursor, EventPayload};
use keeper_indexer::ingest::admin::{admin_history, current_config};
use keeper_indexer::ingest_all;

const ADMIN_1: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADMIN_2: &str = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ADMIN_3: &str = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TOKEN: &str = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const TREASURY: &str = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";

fn at(ledger: u32, payload: EventPayload) -> Event {
    Event::new(EventCursor::new(ledger, 0, 0), payload)
}

/// All seven admin/governance events ingest with their payload fields intact,
/// including `Upgraded`'s `BytesN<32>` wasm hash.
#[tokio::test]
async fn all_seven_admin_events_ingest() {
    let client = skip_without_db!();

    let wasm_hash = [7u8; 32];

    ingest_all(
        &client,
        &[
            at(
                1,
                EventPayload::Initialized {
                    admin: ADMIN_1.to_string(),
                    reward_token: TOKEN.to_string(),
                    fee_bps: 100,
                },
            ),
            at(2, EventPayload::Paused { paused: true }),
            at(
                3,
                EventPayload::FeeUpdated {
                    old_bps: 100,
                    new_bps: 250,
                },
            ),
            at(
                4,
                EventPayload::AdminTransferred {
                    old_admin: ADMIN_1.to_string(),
                    new_admin: ADMIN_2.to_string(),
                },
            ),
            at(
                5,
                EventPayload::MinRewardUpdated {
                    old_min: 0,
                    new_min: 5_000,
                },
            ),
            at(
                6,
                EventPayload::FeesSwept {
                    treasury: TREASURY.to_string(),
                    amount: 900,
                    remaining: 100,
                },
            ),
            at(
                7,
                EventPayload::Upgraded {
                    admin: ADMIN_2.to_string(),
                    new_wasm_hash: wasm_hash,
                },
            ),
        ],
    )
    .await
    .expect("ingest failed");

    let history = admin_history(&client, None).await.unwrap();
    assert_eq!(history.len(), 7);

    let kinds: Vec<&str> = history.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "initialized",
            "paused",
            "fee_updated",
            "admin_transferred",
            "min_reward_updated",
            "fees_swept",
            "upgraded",
        ]
    );

    // The wasm hash round-trips as the exact 32 bytes that were emitted.
    let upgraded = history.iter().find(|r| r.kind == "upgraded").unwrap();
    assert_eq!(upgraded.wasm_hash.as_deref(), Some(&wasm_hash[..]));

    let config = current_config(&client).await.unwrap();
    assert_eq!(config.current_wasm_hash.as_deref(), Some(&wasm_hash[..]));
}

/// Full history is preserved: a later event of the same kind appends, it does
/// not overwrite. This is the audit-trail requirement — a reviewer must see
/// every fee change, not just the current one.
#[tokio::test]
async fn repeated_events_of_one_kind_keep_full_history() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            at(
                1,
                EventPayload::FeeUpdated {
                    old_bps: 0,
                    new_bps: 100,
                },
            ),
            at(
                2,
                EventPayload::FeeUpdated {
                    old_bps: 100,
                    new_bps: 200,
                },
            ),
            at(
                3,
                EventPayload::FeeUpdated {
                    old_bps: 200,
                    new_bps: 300,
                },
            ),
        ],
    )
    .await
    .expect("ingest failed");

    let fees = admin_history(&client, Some("fee_updated")).await.unwrap();
    assert_eq!(fees.len(), 3, "every fee change must be preserved");
    assert_eq!(
        fees.iter()
            .map(|r| r.new_fee_bps.unwrap())
            .collect::<Vec<_>>(),
        vec![100, 200, 300],
        "history must be in chain order"
    );

    // ...while the derived view still reports only the latest.
    assert_eq!(current_config(&client).await.unwrap().fee_bps, Some(300));
}

/// The current-config view is correct after replaying a mixed, interleaved
/// sequence — not just a tidy one-of-each run. Each field must track the
/// latest event that sets *it*, independently of the others.
#[tokio::test]
async fn current_config_is_correct_after_a_mixed_sequence() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            at(
                1,
                EventPayload::Initialized {
                    admin: ADMIN_1.to_string(),
                    reward_token: TOKEN.to_string(),
                    fee_bps: 100,
                },
            ),
            at(2, EventPayload::Paused { paused: true }),
            at(
                3,
                EventPayload::FeeUpdated {
                    old_bps: 100,
                    new_bps: 250,
                },
            ),
            at(
                4,
                EventPayload::AdminTransferred {
                    old_admin: ADMIN_1.to_string(),
                    new_admin: ADMIN_2.to_string(),
                },
            ),
            // unpaused again
            at(5, EventPayload::Paused { paused: false }),
            at(
                6,
                EventPayload::MinRewardUpdated {
                    old_min: 0,
                    new_min: 5_000,
                },
            ),
            // fee changes a second time, after the admin transfer
            at(
                7,
                EventPayload::FeeUpdated {
                    old_bps: 250,
                    new_bps: 175,
                },
            ),
            // and the admin transfers a second time
            at(
                8,
                EventPayload::AdminTransferred {
                    old_admin: ADMIN_2.to_string(),
                    new_admin: ADMIN_3.to_string(),
                },
            ),
            at(
                9,
                EventPayload::MinRewardUpdated {
                    old_min: 5_000,
                    new_min: 1_200,
                },
            ),
        ],
    )
    .await
    .expect("ingest failed");

    let config = current_config(&client).await.unwrap();
    assert_eq!(config.fee_bps, Some(175));
    assert_eq!(config.admin.as_deref(), Some(ADMIN_3));
    assert!(!config.paused);
    assert_eq!(config.min_reward, 1_200);
    assert_eq!(config.reward_token.as_deref(), Some(TOKEN));

    // The history behind that derived state is still complete.
    assert_eq!(admin_history(&client, None).await.unwrap().len(), 9);
}

/// Before any event has been seen the view must report the contract's own
/// defaults rather than inventing values: unpaused, min reward 0, and no admin
/// or fee yet.
#[tokio::test]
async fn current_config_reports_contract_defaults_when_empty() {
    let client = skip_without_db!();

    let config = current_config(&client).await.unwrap();
    assert_eq!(config.fee_bps, None);
    assert_eq!(config.admin, None);
    assert!(!config.paused);
    assert_eq!(config.min_reward, 0);
}

/// Ordering is by the full cursor, not by ledger alone — two events in the
/// same ledger must still resolve to the later one.
#[tokio::test]
async fn later_event_in_the_same_ledger_wins() {
    let client = skip_without_db!();

    ingest_all(
        &client,
        &[
            Event::new(
                EventCursor::new(9, 0, 0),
                EventPayload::FeeUpdated {
                    old_bps: 0,
                    new_bps: 100,
                },
            ),
            Event::new(
                EventCursor::new(9, 0, 1),
                EventPayload::FeeUpdated {
                    old_bps: 100,
                    new_bps: 400,
                },
            ),
        ],
    )
    .await
    .expect("ingest failed");

    assert_eq!(current_config(&client).await.unwrap().fee_bps, Some(400));
    assert_eq!(admin_history(&client, None).await.unwrap().len(), 2);
}

/// Re-delivering the same admin events must not duplicate the audit trail.
#[tokio::test]
async fn re_ingesting_admin_events_is_idempotent() {
    let client = skip_without_db!();

    let events = vec![
        at(
            1,
            EventPayload::Initialized {
                admin: ADMIN_1.to_string(),
                reward_token: TOKEN.to_string(),
                fee_bps: 100,
            },
        ),
        at(2, EventPayload::Paused { paused: true }),
    ];

    ingest_all(&client, &events).await.expect("ingest failed");
    ingest_all(&client, &events)
        .await
        .expect("re-ingest failed");

    assert_eq!(admin_history(&client, None).await.unwrap().len(), 2);
}
