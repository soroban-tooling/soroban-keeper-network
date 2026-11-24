/**
 * Keeper Task Registration Generator for Token Vesting Milestones
 */

import type { VestingScheduleConfig } from "../src/vesting.ts";

export interface VestingKeeperTask {
  taskId: string;
  milestone: string;
  trancheNumber: number;
  triggerTimestamp: number;
  expectedReleaseAmount: string;
  rewardStroops: string;
  condition: {
    type: string;
    minimumTimestamp: number;
  };
}

export function generateVestingKeeperTasks(
  contractAddress: string,
  config: VestingScheduleConfig,
  keeperRewardStroops: bigint = 50_000n
): VestingKeeperTask[] {
  const tasks: VestingKeeperTask[] = [];

  // 1. Cliff Task (unlocks all elapsed tranches up to cliff)
  const cliffElapsed = config.cliffTimestamp - config.startTimestamp;
  const cliffTranches = Math.floor(cliffElapsed / config.trancheIntervalSeconds);
  const cliffAmount =
    (config.totalAmount * BigInt(cliffTranches)) / BigInt(config.numTranches);

  tasks.push({
    taskId: `vesting-${contractAddress}-cliff`,
    milestone: "cliff",
    trancheNumber: cliffTranches,
    triggerTimestamp: config.cliffTimestamp,
    expectedReleaseAmount: cliffAmount.toString(),
    rewardStroops: keeperRewardStroops.toString(),
    condition: {
      type: "time-window-condition",
      minimumTimestamp: config.cliffTimestamp,
    },
  });

  // 2. Subsequent Tranches after cliff
  const singleTrancheAmount = config.totalAmount / BigInt(config.numTranches);

  for (let t = cliffTranches + 1; t <= config.numTranches; t++) {
    const trancheTime = config.startTimestamp + t * config.trancheIntervalSeconds;
    tasks.push({
      taskId: `vesting-${contractAddress}-tranche-${t}`,
      milestone: `tranche-${t}`,
      trancheNumber: t,
      triggerTimestamp: trancheTime,
      expectedReleaseAmount: singleTrancheAmount.toString(),
      rewardStroops: keeperRewardStroops.toString(),
      condition: {
        type: "time-window-condition",
        minimumTimestamp: trancheTime,
      },
    });
  }

  return tasks;
}
