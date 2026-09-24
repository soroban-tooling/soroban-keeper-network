import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadProfitabilityConfig } from "../src/config.js";
import {
  claimIfProfitable,
  estimateTaskProfitability,
} from "../src/profitability.js";

const config = loadProfitabilityConfig({
  KEEPER_MIN_PROFIT_STROOPS: "200",
  KEEPER_EXECUTE_FEE_FALLBACK_STROOPS: "300",
  KEEPER_WITHDRAWAL_FEE_STROOPS: "100",
  KEEPER_WITHDRAWAL_BATCH_SIZE: "10",
  KEEPER_PROFIT_RISK_BUFFER_STROOPS: "40",
  KEEPER_MAX_ESTIMATE_AGE_MS: "1000",
});

describe("keeper profitability", () => {
  it("subtracts the current protocol fee and every configured cost", () => {
    const result = estimateTaskProfitability(
      {
        taskId: 7n,
        rewardStroops: 2_000n,
        feeBps: 500,
        claimFeeStroops: 100n,
        executeFeeStroops: 200n,
        verifierFeeStroops: 50n,
        executorCostStroops: 100n,
        estimateCreatedAtMs: 5_000,
      },
      config,
      5_500,
    );

    assert.equal(result.protocolFeeStroops, 100n);
    assert.equal(result.keeperRewardStroops, 1_900n);
    assert.equal(result.totalCostStroops, 500n);
    assert.equal(result.expectedProfitStroops, 1_400n);
    assert.equal(result.profitable, true);
    assert.equal(result.usedExecuteFeeFallback, false);
  });

  it("uses the configured execute estimate when pre-claim simulation is unavailable", () => {
    const result = estimateTaskProfitability(
      {
        taskId: 8n,
        rewardStroops: 1_000n,
        feeBps: 0,
        claimFeeStroops: 100n,
        estimateCreatedAtMs: 5_000,
      },
      config,
      5_100,
    );

    assert.equal(result.totalCostStroops, 450n);
    assert.equal(result.usedExecuteFeeFallback, true);
  });

  it("logs an unprofitable skip and never claims the task", async () => {
    let claimed = false;
    const events: string[] = [];

    const result = await claimIfProfitable(
      { taskId: 9n, rewardStroops: 500n },
      config,
      {
        getFeeBps: async () => 1_000,
        estimateCosts: async () => ({
          claimFeeStroops: 100n,
          executeFeeStroops: 200n,
          estimateCreatedAtMs: 5_000,
        }),
        claim: async () => {
          claimed = true;
        },
        logger: {
          info: (event) => events.push(event),
        },
        nowMs: () => 5_100,
      },
    );

    assert.equal(result.profitable, false);
    assert.equal(result.reason, "unprofitable");
    assert.equal(claimed, false);
    assert.deepEqual(events, ["task_skipped_unprofitable"]);
  });

  it("fails closed when the cost estimate is stale", () => {
    const result = estimateTaskProfitability(
      {
        taskId: 10n,
        rewardStroops: 10_000n,
        feeBps: 0,
        claimFeeStroops: 1n,
        executeFeeStroops: 1n,
        estimateCreatedAtMs: 1_000,
      },
      config,
      2_001,
    );

    assert.equal(result.profitable, false);
    assert.equal(result.reason, "stale_estimate");
  });

  it("rejects malformed configurable assumptions", () => {
    assert.throws(
      () => loadProfitabilityConfig({ KEEPER_WITHDRAWAL_BATCH_SIZE: "0" }),
      /Invalid KEEPER_WITHDRAWAL_BATCH_SIZE/,
    );
  });
});
