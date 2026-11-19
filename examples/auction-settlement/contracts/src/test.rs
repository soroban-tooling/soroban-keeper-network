#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};

#[test]
fn test_auction_settlement_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(AuctionContract, ());
    let client = AuctionContractClient::new(&env, &contract_id);

    let seller = Address::generate(&env);
    let bidder1 = Address::generate(&env);
    let bidder2 = Address::generate(&env);

    // Mock token
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_admin_client = StellarAssetClient::new(&env, &token_id.address());
    let token_client = TokenClient::new(&env, &token_id.address());

    token_admin_client.mint(&bidder1, &50_000);
    token_admin_client.mint(&bidder2, &50_000);

    let start_time = 1_000_000u64;
    let end_time = 1_003_600u64; // 1 hour auction
    env.ledger().set_timestamp(start_time);

    let auction_id = client.create_auction(&seller, &token_id.address(), &101, &1_000, &end_time);

    // Bidding phase
    client.bid(&bidder1, &auction_id, &1_500);
    assert_eq!(token_client.balance(&bidder1), 48_500);

    // Bidder2 outbids -> Bidder1 refunded automatically
    client.bid(&bidder2, &auction_id, &2_000);
    assert_eq!(token_client.balance(&bidder1), 50_000); // refunded
    assert_eq!(token_client.balance(&bidder2), 48_000);

    // 1. CRITERION 1: Settlement before the end time MUST fail!
    env.ledger().set_timestamp(end_time - 100);
    let res_early = client.try_settle_auction(&auction_id);
    assert_eq!(
        res_early.unwrap_err().unwrap(),
        AuctionError::AuctionNotEnded
    );

    // 2. Settlement at/after end time succeeds!
    env.ledger().set_timestamp(end_time);
    client.settle_auction(&auction_id);

    // Seller receives winning bid
    assert_eq!(token_client.balance(&seller), 2_000);

    let auc = client.get_auction(&auction_id);
    assert_eq!(auc.status, AuctionStatus::Settled);
    assert_eq!(auc.highest_bidder, Some(bidder2));
}
