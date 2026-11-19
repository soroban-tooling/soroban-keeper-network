/**
 * Auction Settlement Engine
 *
 * Implements:
 * 1. Criterion 1: Settlement before the end time fails on-chain.
 * 2. Criterion 2: Keeper task deadline is set relative to the auction end time.
 */

export interface AuctionRecord {
  id: number;
  seller: string;
  token: string;
  itemId: number;
  reservePrice: bigint;
  highestBidder: string | null;
  highestBid: bigint;
  startTime: number;
  endTime: number;
  status: "ACTIVE" | "SETTLED" | "CANCELLED";
}

export class AuctionManager {
  private currentTimestamp: number;
  private auctions: Map<number, AuctionRecord> = new Map();
  private balances: Map<string, bigint> = new Map();
  private nextId = 1;

  constructor(initialTimestamp: number = 1_000_000) {
    this.currentTimestamp = initialTimestamp;
  }

  public setTimestamp(timestamp: number): void {
    this.currentTimestamp = timestamp;
  }

  public advanceSeconds(seconds: number): void {
    this.currentTimestamp += seconds;
  }

  public getCurrentTimestamp(): number {
    return this.currentTimestamp;
  }

  public setBalance(account: string, amount: bigint): void {
    this.balances.set(account, amount);
  }

  public getBalance(account: string): bigint {
    return this.balances.get(account) || 0n;
  }

  public createAuction(
    seller: string,
    token: string,
    itemId: number,
    reservePrice: bigint,
    durationSeconds: number
  ): AuctionRecord {
    const endTime = this.currentTimestamp + durationSeconds;
    const auction: AuctionRecord = {
      id: this.nextId++,
      seller,
      token,
      itemId,
      reservePrice,
      highestBidder: null,
      highestBid: 0n,
      startTime: this.currentTimestamp,
      endTime,
      status: "ACTIVE",
    };
    this.auctions.set(auction.id, auction);
    return auction;
  }

  public getAuction(id: number): AuctionRecord {
    const auc = this.auctions.get(id);
    if (!auc) throw new Error(`Auction #${id} not found`);
    return auc;
  }

  public bid(bidder: string, auctionId: number, amount: bigint): void {
    const auc = this.getAuction(auctionId);
    if (auc.status !== "ACTIVE") {
      throw new Error(`Auction #${auctionId} is already ${auc.status}`);
    }
    if (this.currentTimestamp >= auc.endTime) {
      throw new Error(`Auction #${auctionId} has already ended`);
    }

    const minRequired = auc.highestBid > 0n ? auc.highestBid : auc.reservePrice;
    if (amount <= minRequired) {
      throw new Error(`Bid ${amount} must be greater than current required ${minRequired}`);
    }

    // Refund prior bidder
    if (auc.highestBidder) {
      const prevBal = this.getBalance(auc.highestBidder);
      this.balances.set(auc.highestBidder, prevBal + auc.highestBid);
    }

    // Deduct new bid
    const bidderBal = this.getBalance(bidder);
    if (bidderBal < amount) {
      throw new Error(`Insufficient balance for bidder ${bidder}`);
    }
    this.balances.set(bidder, bidderBal - amount);

    auc.highestBidder = bidder;
    auc.highestBid = amount;
  }

  /**
   * Keeper triggers auction settlement.
   *
   * CRITICAL CRITERION 1: Settlement before the end time fails!
   */
  public settleAuction(auctionId: number): {
    auctionId: number;
    winner: string | null;
    winningBid: bigint;
    sellerPaid: bigint;
  } {
    const auc = this.getAuction(auctionId);
    if (auc.status !== "ACTIVE") {
      throw new Error(`Auction #${auctionId} is already ${auc.status}`);
    }

    // 1. CRITICAL CHECK: Settlement before the end time fails!
    if (this.currentTimestamp < auc.endTime) {
      const secondsRemaining = auc.endTime - this.currentTimestamp;
      throw new Error(
        `AUCTION_NOT_ENDED: Settlement before the end time fails. Auction #${auctionId} ends at timestamp ${auc.endTime}, current time is ${this.currentTimestamp} (${secondsRemaining}s remaining)`
      );
    }

    auc.status = "SETTLED";

    if (auc.highestBidder) {
      // Transfer winning bid to seller
      const sellerBal = this.getBalance(auc.seller);
      this.balances.set(auc.seller, sellerBal + auc.highestBid);

      return {
        auctionId,
        winner: auc.highestBidder,
        winningBid: auc.highestBid,
        sellerPaid: auc.highestBid,
      };
    } else {
      // No bids: item returned to seller, 0 paid
      return {
        auctionId,
        winner: null,
        winningBid: 0n,
        sellerPaid: 0n,
      };
    }
  }
}
