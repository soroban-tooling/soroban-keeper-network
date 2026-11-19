/**
 * DCA Task Controller Script
 *
 * Handles keeper task registration and owner cancellation requests.
 */

import type { DcaPlanRecord } from "../src/dca.ts";

export interface DcaKeeperTaskPayload {
  taskId: string;
  planId: number;
  targetContract: string;
  functionName: string;
  args: [number];
  dueLedger: number;
  fixedSwapAmount: string;
  rewardStroops: string;
}

export function buildDcaKeeperTask(
  dcaContractAddress: string,
  plan: DcaPlanRecord,
  rewardStroops: bigint = 50_000n
): DcaKeeperTaskPayload {
  return {
    taskId: `dca-plan-${plan.id}-swap-${plan.totalSwapsExecuted + 1}`,
    planId: plan.id,
    targetContract: dcaContractAddress,
    functionName: "execute_dca_swap",
    args: [plan.id],
    dueLedger: plan.lastSwapLedger + plan.intervalLedgers,
    fixedSwapAmount: plan.fixedSwapAmount.toString(),
    rewardStroops: rewardStroops.toString(),
  };
}

export function buildCancelDcaTaskPayload(
  dcaContractAddress: string,
  planId: number
) {
  return {
    targetContract: dcaContractAddress,
    functionName: "cancel_dca_plan",
    args: [planId],
    description: "Owner stops DCA schedule and reclaims remaining unswapped balance",
  };
}
