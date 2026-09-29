/**
 * Profitability module tests
 *
 * Tests for profitability calculation (issue #0254), including:
 * - Net profit estimation
 * - Minimum margin enforcement
 * - Verifier cost inclusion
 * - Deterministic behavior
 */

import { describe, it, expect } from "vitest";
import {
  estimateTaskProfitability,
  estimateCandidatesProfitability,
  getExpectedNetProfit,
  isProfitable,
} from "../src/profitability.js";
import type { EvaluatedCandidate, ProfitabilityConfig } from "../src/types.js";

/**
 * Helper: Create an EvaluatedCandidate for testing
 */
function createCandidate(
  taskId: bigint,
  reward: bigint,
  hasVerifier: boolean = false
): EvaluatedCandidate {
  return {
    taskId,
    taskType: 0,
    taskTypeName: "Liquidation",
    calldata: Buffer.alloc(0),
    reward,
    deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    verifier: hasVerifier ? "CBCDEF..." : null,
  };
}

/**
 * Helper: Create default profitability config
 */
function createConfig(minProfitMargin: bigint = 0n): ProfitabilityConfig {
  return {
    minProfitMarginStroops: minProfitMargin,
    estimatedClaimFeeStroops: 10_000n,
    estimatedExecuteBaseFeeStroops: 50_000n,
    estimatedVerifierFeeStroops: 50_000n,
  };
}

describe("profitability", () => {
  describe("estimateTaskProfitability", () => {
    it("calculates net profit correctly for a simple task", () => {
      const candidate = createCandidate(1n, 100_000n);
      const config = createConfig();

      const result = estimateTaskProfitability(candidate, config);

      // reward (100_000) - claim (10_000) - execute (50_000) - verifier (0)
      // = 100_000 - 60_000 = 40_000
      expect(result.netProfit).toBe(40_000n);
      expect(result.estimatedFee).toBe(60_000n);
      expect(result.profitable).toBe(true);
    });

    it("includes verifier fee when task has a verifier", () => {
      const candidate = createCandidate(1n, 200_000n, true); // has verifier
      const config = createConfig();

      const result = estimateTaskProfitability(candidate, config);

      // reward (200_000) - claim (10_000) - execute (50_000) - verifier (50_000)
      // = 200_000 - 110_000 = 90_000
      expect(result.netProfit).toBe(90_000n);
      expect(result.estimatedFee).toBe(110_000n);
      expect(result.profitable).toBe(true);
    });

    it("marks unprofitable tasks when net profit below margin", () => {
      const candidate = createCandidate(1n, 50_000n);
      const config = createConfig(40_000n); // margin: 40_000

      const result = estimateTaskProfitability(candidate, config);

      // reward (50_000) - fees (60_000) = -10_000 (unprofitable)
      expect(result.profitable).toBe(false);
      expect(result.netProfit).toBe(-10_000n);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("below minimum margin");
    });

    it("respects custom fee estimates", () => {
      const candidate = createCandidate(1n, 500_000n);
      const config: ProfitabilityConfig = {
        minProfitMarginStroops: 0n,
        estimatedClaimFeeStroops: 100_000n,
        estimatedExecuteBaseFeeStroops: 200_000n,
        estimatedVerifierFeeStroops: 50_000n,
      };

      const result = estimateTaskProfitability(candidate, config);

      // reward (500_000) - claim (100_000) - execute (200_000) - verifier (0)
      // = 500_000 - 300_000 = 200_000
      expect(result.netProfit).toBe(200_000n);
      expect(result.estimatedFee).toBe(300_000n);
      expect(result.profitable).toBe(true);
    });

    it("handles edge case: exactly at margin threshold", () => {
      const candidate = createCandidate(1n, 60_000n); // reward = fees
      const config = createConfig(0n);

      const result = estimateTaskProfitability(candidate, config);

      expect(result.netProfit).toBe(0n);
      expect(result.profitable).toBe(true); // >= margin (0)
    });

    it("handles edge case: just below margin threshold", () => {
      const candidate = createCandidate(1n, 60_000n);
      const config = createConfig(1n); // margin: 1 stroops

      const result = estimateTaskProfitability(candidate, config);

      expect(result.netProfit).toBe(0n);
      expect(result.profitable).toBe(false); // 0 < margin (1)
    });

    it("handles large reward values correctly", () => {
      const largeReward = 1_000_000_000n; // 1B stroops
      const candidate = createCandidate(1n, largeReward);
      const config = createConfig();

      const result = estimateTaskProfitability(candidate, config);

      // reward (1B) - fees (60_000) ≈ 1B
      expect(result.netProfit).toBe(largeReward - 60_000n);
      expect(result.profitable).toBe(true);
    });

    it("handles very small reward (unprofitable)", () => {
      const candidate = createCandidate(1n, 100n); // tiny reward
      const config = createConfig();

      const result = estimateTaskProfitability(candidate, config);

      // reward (100) - fees (60_000) = -59_900
      expect(result.netProfit).toBe(-59_900n);
      expect(result.profitable).toBe(false);
    });
  });

  describe("estimateCandidatesProfitability", () => {
    it("evaluates multiple candidates in batch", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 150_000n),
        createCandidate(3n, 50_000n),
      ];
      const config = createConfig();

      const results = estimateCandidatesProfitability(candidates, config);

      expect(results).toHaveLength(3);
      expect(results[0]!.netProfit).toBe(40_000n); // 100_000 - 60_000
      expect(results[1]!.netProfit).toBe(90_000n); // 150_000 - 60_000
      expect(results[2]!.netProfit).toBe(-10_000n); // 50_000 - 60_000
    });

    it("preserves order of input candidates", () => {
      const candidates = [
        createCandidate(10n, 100_000n),
        createCandidate(5n, 150_000n),
        createCandidate(1n, 50_000n),
      ];
      const config = createConfig();

      const results = estimateCandidatesProfitability(candidates, config);

      expect(results[0]!.netProfit).toBe(40_000n);
      expect(results[1]!.netProfit).toBe(90_000n);
      expect(results[2]!.netProfit).toBe(-10_000n);
    });

    it("handles empty array", () => {
      const results = estimateCandidatesProfitability([], createConfig());
      expect(results).toHaveLength(0);
    });
  });

  describe("getExpectedNetProfit", () => {
    it("returns net profit value for ranking", () => {
      const candidate = createCandidate(1n, 100_000n);
      const config = createConfig();

      const profit = getExpectedNetProfit(candidate, config);

      expect(profit).toBe(40_000n);
    });

    it("returns negative profit for unprofitable tasks", () => {
      const candidate = createCandidate(1n, 30_000n);
      const config = createConfig();

      const profit = getExpectedNetProfit(candidate, config);

      expect(profit).toBe(-30_000n); // 30_000 - 60_000
      expect(profit < 0n).toBe(true);
    });

    it("uses the ranking key consistently", () => {
      const candidate1 = createCandidate(1n, 100_000n);
      const candidate2 = createCandidate(2n, 100_000n);
      const config = createConfig();

      const profit1 = getExpectedNetProfit(candidate1, config);
      const profit2 = getExpectedNetProfit(candidate2, config);

      // Same reward = same profit
      expect(profit1).toBe(profit2);
    });
  });

  describe("isProfitable", () => {
    it("returns true for profitable tasks", () => {
      const candidate = createCandidate(1n, 100_000n);
      const config = createConfig();

      expect(isProfitable(candidate, config)).toBe(true);
    });

    it("returns false for unprofitable tasks", () => {
      const candidate = createCandidate(1n, 30_000n);
      const config = createConfig();

      expect(isProfitable(candidate, config)).toBe(false);
    });

    it("respects minimum margin configuration", () => {
      const candidate = createCandidate(1n, 80_000n);

      // With 0 margin: 80_000 - 60_000 = 20_000 (profitable)
      expect(isProfitable(candidate, createConfig(0n))).toBe(true);

      // With 20_000 margin: exactly at threshold (profitable)
      expect(isProfitable(candidate, createConfig(20_000n))).toBe(true);

      // With 20_001 margin: below threshold (unprofitable)
      expect(isProfitable(candidate, createConfig(20_001n))).toBe(false);
    });
  });

  describe("determinism", () => {
    it("produces identical results on repeated calls", () => {
      const candidate = createCandidate(1n, 123_456n);
      const config = createConfig(50_000n);

      const result1 = estimateTaskProfitability(candidate, config);
      const result2 = estimateTaskProfitability(candidate, config);
      const result3 = estimateTaskProfitability(candidate, config);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
    });

    it("produces identical results regardless of call order", () => {
      const candidate1 = createCandidate(1n, 100_000n);
      const candidate2 = createCandidate(2n, 150_000n);
      const config = createConfig();

      // Evaluate in different orders
      const result1a = estimateTaskProfitability(candidate1, config);
      const result2a = estimateTaskProfitability(candidate2, config);

      const result2b = estimateTaskProfitability(candidate2, config);
      const result1b = estimateTaskProfitability(candidate1, config);

      expect(result1a).toEqual(result1b);
      expect(result2a).toEqual(result2b);
    });
  });
});
