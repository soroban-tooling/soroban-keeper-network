#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AuctionError {
    NotFound = 1,
    AuctionAlreadyEnded = 2,
    AuctionNotEnded = 3,
    BidTooLow = 4,
    AuctionAlreadySettled = 5,
    InvalidParameters = 6,
    Unauthorized = 7,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AuctionStatus {
    Active = 1,
    Settled = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Auction {
    pub id: u64,
    pub seller: Address,
    pub token: Address,
    pub item_id: u64,
    pub reserve_price: i128,
    pub highest_bidder: Option<Address>,
    pub highest_bid: i128,
    pub end_time: u64,
    pub status: AuctionStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    AuctionCount,
    Auction(u64),
}

#[contract]
pub struct AuctionContract;

#[contractimpl]
impl AuctionContract {
    /// Create a new auction for an item with an end timestamp.
    pub fn create_auction(
        env: Env,
        seller: Address,
        token: Address,
        item_id: u64,
        reserve_price: i128,
        end_time: u64,
    ) -> Result<u64, AuctionError> {
        seller.require_auth();

        if reserve_price <= 0 || end_time <= env.ledger().timestamp() {
            return Err(AuctionError::InvalidParameters);
        }

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AuctionCount)
            .unwrap_or(0);
        count = count.saturating_add(1);

        let auction = Auction {
            id: count,
            seller: seller.clone(),
            token,
            item_id,
            reserve_price,
            highest_bidder: None,
            highest_bid: 0,
            end_time,
            status: AuctionStatus::Active,
        };

        env.storage().instance().set(&DataKey::AuctionCount, &count);
        env.storage().persistent().set(&DataKey::Auction(count), &auction);
        env.storage().persistent().extend_ttl(&DataKey::Auction(count), 1000, 100000);

        env.events().publish(
            (symbol_short!("auc_new"),),
            (count, seller, item_id, reserve_price, end_time),
        );

        Ok(count)
    }

    /// Place a bid. Refunds previous highest bidder automatically.
    pub fn bid(
        env: Env,
        bidder: Address,
        auction_id: u64,
        amount: i128,
    ) -> Result<(), AuctionError> {
        bidder.require_auth();

        let mut auction: Auction = env
            .storage()
            .persistent()
            .get(&DataKey::Auction(auction_id))
            .ok_or(AuctionError::NotFound)?;

        if auction.status != AuctionStatus::Active {
            return Err(AuctionError::AuctionAlreadySettled);
        }

        let current_time = env.ledger().timestamp();
        if current_time >= auction.end_time {
            return Err(AuctionError::AuctionAlreadyEnded);
        }

        // Must beat reserve price and current highest bid
        let min_required = if auction.highest_bid > 0 {
            auction.highest_bid
        } else {
            auction.reserve_price
        };

        if amount <= min_required {
            return Err(AuctionError::BidTooLow);
        }

        let token_client = token::Client::new(&env, &auction.token);

        // Pull new bid into contract custody
        token_client.transfer(&bidder, &env.current_contract_address(), &amount);

        // Refund previous bidder if one existed
        if let Some(prev_bidder) = &auction.highest_bidder {
            token_client.transfer(
                &env.current_contract_address(),
                prev_bidder,
                &auction.highest_bid,
            );
        }

        auction.highest_bidder = Some(bidder.clone());
        auction.highest_bid = amount;

        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);

        env.events().publish(
            (symbol_short!("auc_bid"),),
            (auction_id, bidder, amount),
        );

        Ok(())
    }

    /// Settle auction: Callable permissionlessly by keeper bots after auction.end_time.
    ///
    /// CRITICAL CRITERION 1: Settlement before the end time fails!
    pub fn settle_auction(env: Env, auction_id: u64) -> Result<(), AuctionError> {
        let mut auction: Auction = env
            .storage()
            .persistent()
            .get(&DataKey::Auction(auction_id))
            .ok_or(AuctionError::NotFound)?;

        if auction.status != AuctionStatus::Active {
            return Err(AuctionError::AuctionAlreadySettled);
        }

        let current_time = env.ledger().timestamp();

        // 1. CRITICAL CHECK: Refuse settlement before auction end
        if current_time < auction.end_time {
            return Err(AuctionError::AuctionNotEnded);
        }

        let token_client = token::Client::new(&env, &auction.token);

        if let Some(winner) = &auction.highest_bidder {
            // Winning bid exists: transfer payment to seller
            token_client.transfer(
                &env.current_contract_address(),
                &auction.seller,
                &auction.highest_bid,
            );

            env.events().publish(
                (symbol_short!("auc_win"),),
                (auction_id, winner.clone(), auction.highest_bid),
            );
        } else {
            // No bids: item returned to seller
            env.events().publish(
                (symbol_short!("auc_nobid"),),
                (auction_id, auction.seller.clone()),
            );
        }

        auction.status = AuctionStatus::Settled;
        env.storage().persistent().set(&DataKey::Auction(auction_id), &auction);

        Ok(())
    }

    pub fn get_auction(env: Env, auction_id: u64) -> Result<Auction, AuctionError> {
        env.storage()
            .persistent()
            .get(&DataKey::Auction(auction_id))
            .ok_or(AuctionError::NotFound)
    }
}

#[cfg(test)]
mod test;
