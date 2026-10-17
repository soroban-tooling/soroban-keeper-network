/**
 * Integration tests for oracle prechecking in the round loop (issue #0426)
 *
 * Validates:
 * 1. Oracle precheck integration with candidate evaluation pipeline
 * 2. Feed caching efficiency during candidate processing
 * 3. Filtering behavior (candidates with unmet predictions are skipped)
 * 4. Fallback paths when feed reads fail
 * 5. End-to-end round flow with oracle predictions
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  preCheckOracleConditions,
  filterByOraclePrediction,
  evaluateAndRankCandidates,
} from "../src/loop.js";
import type { EvaluatedCandidate, ConditionEvaluationOptions } from "../src/types.js";
import type { OracleFeedData } from "../src/conditions.js";
import { encodeOraclePriceThresholdCondition } from "./helpers/oracle-encoding.js";

describe("Oracle Precheck Integration", () => {
  const mockFeedReader = vi.fn<[any], Promise<OracleFeedData>>(async (feedId) => ({
    feedId,
    price: 50000n,
    decimals: 8,
    timestamp: Math.floor(Date.now() / 1000),
    source: "reflector",
  }));

  beforeEach(() => {
    mockFeedReader.mockClear();
  });

  it("processes candidates without oracle conditions unchanged", async () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 0,
        taskTypeName: "Liquidation",
        calldata: Buffer.from([0x01, 0x02]),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const result = await preCheckOracleConditions(candidates, mockFeedReader);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].condition).toBeUndefined(); // No oracle condition
    expect(mockFeedReader).not.toHaveBeenCalled(); // No feed read
  });

  it("skips oracle precheck when disabled", async () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: Buffer.from([0x01, 0x02]),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const options: ConditionEvaluationOptions = {
      useOraclePrediction: false,
    };

    const result = await preCheckOracleConditions(candidates, mockFeedReader, options);

    expect(result.candidates).toEqual(candidates);
    expect(result.skippedByOraclePrediction).toHaveLength(0);
  });

  it("handles feed read errors with fallback", async () => {
    const failingReader = vi.fn(async () => {
      throw new Error("Connection timeout");
    });

    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" },
          threshold: 50000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const options: ConditionEvaluationOptions = {
      fallbackToSimulation: true,
    };

    const result = await preCheckOracleConditions(candidates, failingReader, options);

    // With fallback, candidate should not be marked for skipping
    expect(result.skippedByOraclePrediction).toHaveLength(0);
    // But condition.prediction might not be set (fallback to simulation)
    expect(result.candidates[0].condition?.prediction).toBeUndefined();
  });

  it("skips candidates with failed feed reads when fallback disabled", async () => {
    const failingReader = vi.fn(async () => {
      throw new Error("Connection timeout");
    });

    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" },
          threshold: 50000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const options: ConditionEvaluationOptions = {
      fallbackToSimulation: false,
    };

    const result = await preCheckOracleConditions(candidates, failingReader, options);

    // Without fallback, candidate should be skipped
    expect(result.skippedByOraclePrediction).toContain(1n);
    // Prediction should indicate failure
    expect(result.candidates[0].condition?.prediction?.claimable).toBe(false);
  });

  it("caches feeds across multiple tasks", async () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" },
          threshold: 50000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
      {
        taskId: 2n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" }, // Same feed
          threshold: 45000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const result = await preCheckOracleConditions(candidates, mockFeedReader);

    // Feed should be read only once for both tasks
    expect(mockFeedReader).toHaveBeenCalledTimes(1);
    expect(result.cache.getStats().distinctFeeds).toBe(1);
  });

  it("attaches prediction data to candidates", async () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" },
          threshold: 50000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const result = await preCheckOracleConditions(candidates, mockFeedReader);

    expect(result.candidates[0].condition?.prediction).toBeDefined();
    expect(result.candidates[0].condition?.prediction?.claimable).toBe(true); // 50000 >= 50000
    expect(result.candidates[0].condition?.prediction?.method).toBe("oracle_feed");
    expect(result.candidates[0].condition?.skipped_simulation).toBe(true);
  });

  it("marks candidates with unmet predictions for skipping", async () => {
    const lowPriceReader = vi.fn(async () => ({
      feedId: { base: "BTC", quote: "USD" },
      price: 40000n, // Below threshold
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    }));

    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" },
          threshold: 50000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const result = await preCheckOracleConditions(candidates, lowPriceReader);

    expect(result.skippedByOraclePrediction).toContain(1n);
    expect(result.candidates[0].condition?.prediction?.claimable).toBe(false);
  });
});

describe("Oracle Prediction Filtering", () => {
  it("removes candidates with unmet oracle predictions", () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: Buffer.from([]),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
        condition: {
          prediction: {
            claimable: true,
            method: "oracle_feed",
            timestamp: Math.floor(Date.now() / 1000),
          },
        },
      },
      {
        taskId: 2n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: Buffer.from([]),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
        condition: {
          prediction: {
            claimable: false, // Unmet
            method: "oracle_feed",
            timestamp: Math.floor(Date.now() / 1000),
          },
        },
      },
      {
        taskId: 3n,
        taskType: 0,
        taskTypeName: "Liquidation",
        calldata: Buffer.from([]),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
        // No prediction (non-oracle task)
      },
    ];

    const filtered = filterByOraclePrediction(candidates);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((c) => c.taskId)).toEqual([1n, 3n]);
  });

  it("includes candidates without predictions (will use simulation)", () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 0,
        taskTypeName: "Liquidation",
        calldata: Buffer.from([]),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    const filtered = filterByOraclePrediction(candidates);

    expect(filtered).toHaveLength(1);
  });
});

describe("Integration: Precheck → Filter → Rank", () => {
  const mockFeedReader = vi.fn(async (feedId: any) => {
    // Return high price for BTC, low for ETH
    const price = feedId.base === "BTC" ? 55000n : 2500n;
    return {
      feedId,
      price,
      decimals: 8,
      timestamp: Math.floor(Date.now() / 1000),
      source: "reflector",
    };
  });

  beforeEach(() => {
    mockFeedReader.mockClear();
  });

  it("processes candidates through full pipeline", async () => {
    const candidates: EvaluatedCandidate[] = [
      {
        taskId: 1n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "BTC", quote: "USD" },
          threshold: 50000n,
          direction: "above",
          decimals: 8,
        }),
        reward: 200000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
      {
        taskId: 2n,
        taskType: 1,
        taskTypeName: "OraclePricePush",
        calldata: encodeOraclePriceThresholdCondition({
          feedId: { base: "ETH", quote: "USD" },
          threshold: 3000n, // Unmet (feed price is 2500)
          direction: "above",
          decimals: 8,
        }),
        reward: 100000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
      {
        taskId: 3n,
        taskType: 0,
        taskTypeName: "Liquidation",
        calldata: Buffer.from([]),
        reward: 150000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      },
    ];

    // Step 1: Oracle precheck
    const preCheckResult = await preCheckOracleConditions(candidates, mockFeedReader);
    expect(preCheckResult.skippedByOraclePrediction).toContain(2n);

    // Step 2: Filter by prediction
    const filtered = filterByOraclePrediction(preCheckResult.candidates);
    expect(filtered).toHaveLength(2); // 1 and 3 remain

    // Step 3: Rank by profitability
    const profitabilityConfig = {
      minProfitMarginStroops: 50000n,
      estimatedClaimFeeStroops: 10000n,
      estimatedExecuteBaseFeeStroops: 50000n,
    };
    const ranked = evaluateAndRankCandidates(filtered, profitabilityConfig, 10);

    // Should have ranked the remaining candidates
    expect(ranked).toHaveLength(2);
    // Task 1 has more net profit, should be first
    expect(ranked[0]?.taskId).toBe(1n);
  });
});
