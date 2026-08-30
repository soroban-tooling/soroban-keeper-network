use keeper_indexer::events::{EventPayload, I128};
use keeper_indexer::queries::activity::{get_address_activity, ActivityRole};
use keeper_indexer::queries::stats::get_protocol_stats;
use keeper_indexer::store::Store;

#[tokio::test]
async fn test_protocol_stats_and_address_activity() {
    let store = Store::connect("sqlite::memory:").await.expect("connect store");

    // Ingest events
    let owner = "GD5JDJFDG7O5VJ5FBG4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G";
    let keeper = "GB6JDJFDG7O5VJ5FBG4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G4G";

    store
        .insert_event(
            10,
            1000,
            "tx1",
            0,
            &EventPayload::TaskRegistered {
                task_id: 1,
                owner: owner.to_string(),
                reward: I128(1_000_000),
                deadline: 2000,
            },
        )
        .await
        .unwrap();

    store
        .insert_event(
            11,
            1100,
            "tx2",
            0,
            &EventPayload::TaskClaimed {
                task_id: 1,
                keeper: keeper.to_string(),
                claim_ledger: 11,
            },
        )
        .await
        .unwrap();

    store
        .insert_event(
            12,
            1200,
            "tx3",
            0,
            &EventPayload::TaskExecuted {
                task_id: 1,
                keeper: keeper.to_string(),
                net_reward: I128(970_000),
                proof: "deadbeef".to_string(),
            },
        )
        .await
        .unwrap();

    store
        .insert_event(
            13,
            1300,
            "tx4",
            0,
            &EventPayload::FeesSwept {
                treasury: "TREASURY_ADDR".to_string(),
                amount: I128(30_000),
                remaining: I128(0),
            },
        )
        .await
        .unwrap();

    // 1. Verify protocol stats query (Issue #356)
    let stats = get_protocol_stats(&store).await.expect("get_protocol_stats");
    assert_eq!(stats.total_tasks_registered, 1);
    assert_eq!(stats.total_value_escrowed, "1000000");
    assert_eq!(stats.total_fees_swept, "30000");

    // 2. Verify unified address activity feed (Issue #357)
    let owner_feed = get_address_activity(&store, owner, 10, 0)
        .await
        .expect("get_address_activity owner");
    assert_eq!(owner_feed.total_count, 1);
    assert_eq!(owner_feed.items[0].role, ActivityRole::Owner);
    assert_eq!(owner_feed.items[0].event_type, "task_registered");

    let keeper_feed = get_address_activity(&store, keeper, 10, 0)
        .await
        .expect("get_address_activity keeper");
    assert_eq!(keeper_feed.total_count, 2);
    assert_eq!(keeper_feed.items[0].role, ActivityRole::Keeper);
    assert_eq!(keeper_feed.items[0].event_type, "task_claimed");
    assert_eq!(keeper_feed.items[1].role, ActivityRole::Keeper);
    assert_eq!(keeper_feed.items[1].event_type, "task_executed");
}
