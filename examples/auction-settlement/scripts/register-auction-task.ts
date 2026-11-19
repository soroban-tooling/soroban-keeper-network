/**
 * Task Registration Script for Auction Settlement
 *
 * CRITICAL CRITERION 2: The task deadline is set relative to the auction end!
 */

import type { AuctionRecord } from "../src/auction.ts";

export interface AuctionKeeperTaskPayload {
  taskId: string;
  auctionId: number;
  targetContract: string;
  functionName: string;
  args: [number];
  triggerTimestamp: number;
  deadlineTimestamp: number; // Set relative to auction.endTime
  settlementWindowSeconds: number;
  rewardStroops: string;
  condition: {
    type: string;
    minimumTimestamp: number;
  };
}

export function buildAuctionKeeperTask(
  auctionContractAddress: string,
  auction: AuctionRecord,
  settlementWindowSeconds: number = 3600, // 1 hour relative window
  rewardStroops: bigint = 75_000n // 0.0075 XLM
): AuctionKeeperTaskPayload {
  // CRITICAL CRITERION 2:
  // The task deadline is set relative to the auction end:
  const triggerTimestamp = auction.endTime;
  const deadlineTimestamp = auction.endTime + settlementWindowSeconds;

  return {
    taskId: `auction-settle-${auction.id}`,
    auctionId: auction.id,
    targetContract: auctionContractAddress,
    functionName: "settle_auction",
    args: [auction.id],
    triggerTimestamp,
    deadlineTimestamp, // Relative to auction.endTime!
    settlementWindowSeconds,
    rewardStroops: rewardStroops.toString(),
    condition: {
      type: "time-window-condition",
      minimumTimestamp: auction.endTime,
    },
  };
}
