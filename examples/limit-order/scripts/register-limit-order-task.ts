/**
 * Registration Script for Oracle-Driven Limit Order Keeper Task
 */

import type { LimitOrder } from "../src/limit-order.ts";

export interface LimitOrderTaskPayload {
  taskId: string;
  orderId: number;
  targetContract: string;
  functionName: string;
  args: [number];
  conditionAddress: string;
  rewardStroops: string;
  deadlineLedgers: number;
}

export function buildLimitOrderKeeperTask(
  limitOrderContractAddress: string,
  order: LimitOrder,
  rewardStroops: bigint = 100_000n, // 0.01 XLM
  deadlineLedgers: number = 200
): LimitOrderTaskPayload {
  return {
    taskId: `limit-order-${order.id}-${order.tokenIn}-${order.tokenOut}`,
    orderId: order.id,
    targetContract: limitOrderContractAddress,
    functionName: "execute_order",
    args: [order.id],
    conditionAddress: order.conditionAddress, // attached on-chain condition
    rewardStroops: rewardStroops.toString(),
    deadlineLedgers,
  };
}
