import type { ProfitabilityConfig } from "./config.js";

const BASIS_POINTS = 10_000n;

export interface ProfitabilityInputs {
  readonly taskId: bigint;
  readonly rewardStroops: bigint;
  readonly feeBps: number;
  readonly claimFeeStroops: bigint;
  readonly executeFeeStroops?: bigint;
  readonly verifierFeeStroops?: bigint;
  readonly executorCostStroops?: bigint;
  readonly estimateCreatedAtMs: number;
}

export interface ProfitabilityDecision {
  readonly profitable: boolean;
  readonly reason: "profitable" | "unprofitable" | "stale_estimate";
  readonly protocolFeeStroops: bigint;
  readonly keeperRewardStroops: bigint;
  readonly totalCostStroops: bigint;
  readonly expectedProfitStroops: bigint;
  readonly usedExecuteFeeFallback: boolean;
}

export interface ProfitabilityLogger {
  info(event: string, fields: Readonly<Record<string, string>>): void;
}

export interface ClaimDependencies {
  readonly getFeeBps: () => Promise<number>;
  readonly estimateCosts: () => Promise<
    Pick<
      ProfitabilityInputs,
      | "claimFeeStroops"
      | "executeFeeStroops"
      | "verifierFeeStroops"
      | "executorCostStroops"
      | "estimateCreatedAtMs"
    >
  >;
  readonly claim: () => Promise<void>;
  readonly logger: ProfitabilityLogger;
  readonly nowMs?: () => number;
}

function requireNonNegative(name: string, value: bigint): void {
  if (value < 0n) {
    throw new RangeError(`${name} must be non-negative`);
  }
}

function divideRoundUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

export function estimateTaskProfitability(
  inputs: ProfitabilityInputs,
  config: ProfitabilityConfig,
  nowMs = Date.now(),
): ProfitabilityDecision {
  requireNonNegative("rewardStroops", inputs.rewardStroops);
  requireNonNegative("claimFeeStroops", inputs.claimFeeStroops);
  if (!Number.isInteger(inputs.feeBps) || inputs.feeBps < 0 || inputs.feeBps > 10_000) {
    throw new RangeError("feeBps must be an integer from 0 through 10000");
  }

  const executeFee =
    inputs.executeFeeStroops ?? config.executeFeeFallbackStroops;
  const verifierFee = inputs.verifierFeeStroops ?? 0n;
  const executorCost = inputs.executorCostStroops ?? 0n;
  requireNonNegative("executeFeeStroops", executeFee);
  requireNonNegative("verifierFeeStroops", verifierFee);
  requireNonNegative("executorCostStroops", executorCost);

  const protocolFee =
    (inputs.rewardStroops * BigInt(inputs.feeBps)) / BASIS_POINTS;
  const keeperReward = inputs.rewardStroops - protocolFee;
  const withdrawalShare = divideRoundUp(
    config.withdrawalFeeStroops,
    config.withdrawalBatchSize,
  );
  const totalCost =
    inputs.claimFeeStroops +
    executeFee +
    verifierFee +
    executorCost +
    withdrawalShare +
    config.riskBufferStroops;
  const expectedProfit = keeperReward - totalCost;
  const stale =
    nowMs - inputs.estimateCreatedAtMs > config.maximumEstimateAgeMs ||
    inputs.estimateCreatedAtMs > nowMs;

  return {
    profitable: !stale && expectedProfit >= config.minimumProfitStroops,
    reason: stale
      ? "stale_estimate"
      : expectedProfit >= config.minimumProfitStroops
        ? "profitable"
        : "unprofitable",
    protocolFeeStroops: protocolFee,
    keeperRewardStroops: keeperReward,
    totalCostStroops: totalCost,
    expectedProfitStroops: expectedProfit,
    usedExecuteFeeFallback: inputs.executeFeeStroops === undefined,
  };
}

export async function claimIfProfitable(
  task: Pick<ProfitabilityInputs, "taskId" | "rewardStroops">,
  config: ProfitabilityConfig,
  dependencies: ClaimDependencies,
): Promise<ProfitabilityDecision> {
  const [feeBps, costs] = await Promise.all([
    dependencies.getFeeBps(),
    dependencies.estimateCosts(),
  ]);
  const decision = estimateTaskProfitability(
    { ...task, feeBps, ...costs },
    config,
    dependencies.nowMs?.() ?? Date.now(),
  );

  if (!decision.profitable) {
    dependencies.logger.info("task_skipped_unprofitable", {
      taskId: task.taskId.toString(),
      reason: decision.reason,
      expectedProfitStroops: decision.expectedProfitStroops.toString(),
      minimumProfitStroops: config.minimumProfitStroops.toString(),
    });
    return decision;
  }

  await dependencies.claim();
  return decision;
}
