import test from "node:test";
import assert from "node:assert/strict";
import { AuctionManager } from "../src/auction.ts";
import { buildAuctionKeeperTask } from "../scripts/register-auction-task.ts";

test("Criterion 1: Settlement before the end time strictly fails", () => {
  const start = 1_000_000;
  const duration = 3600; // 1-hour auction (ends at 1,003,600)
  const manager = new AuctionManager(start);

  const seller = "GB_SELLER_ADDRESS";
  const bidder = "GB_ALICE_BIDDER";

  manager.setBalance(bidder, 10_000n);

  const auction = manager.createAuction(
    seller,
    "CA_XLM_TOKEN",
    42,
    1_000n,
    duration
  );

  assert.equal(auction.endTime, 1_003_600);

  // Alice places a winning bid of 2,500
  manager.bid(bidder, auction.id, 2_500n);

  // 1. Attempting settlement at Day 0 (start time) -> MUST FAIL
  assert.throws(
    () => manager.settleAuction(auction.id),
    /AUCTION_NOT_ENDED.*Settlement before the end time fails/,
    "Settlement at start time must fail"
  );

  // 2. Attempting settlement 10 minutes before end time -> MUST FAIL
  manager.setTimestamp(auction.endTime - 600);
  assert.throws(
    () => manager.settleAuction(auction.id),
    /AUCTION_NOT_ENDED.*600s remaining/,
    "Settlement 10 mins before end time must fail"
  );

  // 3. Attempting settlement 1 second before end time -> MUST FAIL
  manager.setTimestamp(auction.endTime - 1);
  assert.throws(
    () => manager.settleAuction(auction.id),
    /AUCTION_NOT_ENDED.*1s remaining/,
    "Settlement 1 second before end time must fail"
  );

  // 4. Exactly at auction.endTime, settlement succeeds!
  manager.setTimestamp(auction.endTime);
  const result = manager.settleAuction(auction.id);
  assert.equal(result.winner, bidder);
  assert.equal(result.winningBid, 2_500n);
  assert.equal(manager.getBalance(seller), 2_500n);
  assert.equal(manager.getAuction(auction.id).status, "SETTLED");
});

test("Criterion 2: The task deadline is set relative to the auction end", () => {
  const manager = new AuctionManager(2_000_000);
  const auction = manager.createAuction(
    "GB_ARTIST",
    "CA_USDC",
    99,
    500n,
    7200 // 2 hours duration
  );

  assert.equal(auction.endTime, 2_007_200);

  // Build task with a 30-minute relative settlement window (1800s)
  const task30m = buildAuctionKeeperTask("CC_AUCTION_CONTRACT", auction, 1800);
  assert.equal(task30m.triggerTimestamp, 2_007_200);
  assert.equal(task30m.settlementWindowSeconds, 1800);
  // Deadline MUST be set relative to auction end: endTime + 1800
  assert.equal(task30m.deadlineTimestamp, auction.endTime + 1800);
  assert.equal(task30m.deadlineTimestamp, 2_009_000);

  // Build task with a 2-hour relative settlement window (7200s)
  const task2h = buildAuctionKeeperTask("CC_AUCTION_CONTRACT", auction, 7200);
  // Deadline MUST be set relative to auction end: endTime + 7200
  assert.equal(task2h.deadlineTimestamp, auction.endTime + 7200);
  assert.equal(task2h.deadlineTimestamp, 2_014_400);

  // Verify task payload parameters
  assert.equal(task2h.targetContract, "CC_AUCTION_CONTRACT");
  assert.equal(task2h.functionName, "settle_auction");
  assert.deepEqual(task2h.args, [auction.id]);
  assert.equal(task2h.condition.minimumTimestamp, auction.endTime);
});
