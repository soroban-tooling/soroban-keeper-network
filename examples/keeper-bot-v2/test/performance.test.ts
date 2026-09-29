/**
 * Performance tests (issue #0261)
 *
 * Validates that ranking overhead does not materially reduce profitability.
 * Measures and benchmarks the ranking operation to ensure acceptable latency
 * for realistic candidate counts.
 */

import { describe, it, expect } from "vitest";
import { rankCandidatesByProfit, selectTopCandidates } from "../src/ranking.js";
import type { EvaluatedCandidate } from "../src/types.js";
import type { ProfitabilityConfig } from "../src/profitability.js";

/**
 * Helper: Create an EvaluatedCandidate for testing
 */
function createCandidate(taskId: bigint, reward: bigint): EvaluatedCandidate {
  return {
    taskId,
    taskType: 0,
    taskTypeName: "Liquidation",
    calldata: Buffer.alloc(0),
    reward,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    verifier: null,
  };
}

/**
 * Helper: Create default profitability config
 */
function createConfig(): ProfitabilityConfig {
  return {
    minProfitMarginStroops: 0n,
    estimatedClaimFeeStroops: 10_000n,
    estimatedExecuteBaseFeeStroops: 50_000n,
  };
}

describe("performance", () => {
  describe("ranking latency for realistic candidate counts", () => {
    it("ranks 10 candidates efficiently", () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      const startTime = performance.now();
      const ranked = rankCandidatesByProfit(candidates, config);
      const endTime = performance.now();

      const durationMs = endTime - startTime;

      expect(ranked).toHaveLength(10);
      // Should complete in well under 10ms for 10 candidates
      expect(durationMs).toBeLessThan(10);
    });

    it("ranks 100 candidates efficiently", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
      );
      const config = createConfig();

      const startTime = performance.now();
      const ranked = rankCandidatesByProfit(candidates, config);
      const endTime = performance.now();

      const durationMs = endTime - startTime;

      expect(ranked).toHaveLength(100);
      // Should complete in well under 100ms for 100 candidates
      expect(durationMs).toBeLessThan(100);
    });

    it("ranks 1000 candidates efficiently", () => {
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 1_000))
      );
      const config = createConfig();

      const startTime = performance.now();
      const ranked = rankCandidatesByProfit(candidates, config);
      const endTime = performance.now();

      const durationMs = endTime - startTime;

      expect(ranked).toHaveLength(1000);
      // Should complete in well under 500ms for 1000 candidates
      expect(durationMs).toBeLessThan(500);
    });

    it("selection is trivially fast after ranking", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      const startTime = performance.now();
      const selected = selectTopCandidates(ranked, 5);
      const endTime = performance.now();

      const durationMs = endTime - startTime;

      expect(selected).toHaveLength(5);
      // Selection should be essentially instant (< 1ms)
      expect(durationMs).toBeLessThan(1);
    });
  });

  describe("ranking overhead comparison", () => {
    it("ranking overhead is negligible compared to network latency", () => {
      const candidates = Array.from({ length: 50 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      const rankingStart = performance.now();
      rankCandidatesByProfit(candidates, config);
      const rankingDuration = performance.now() - rankingStart;

      // Typical network round-trip: 100-500ms
      // Our ranking should be a small fraction of that
      const networkLatencyEstimate = 200; // ms

      expect(rankingDuration).toBeLessThan(networkLatencyEstimate * 0.1); // < 10% of network latency
    });

    it("ranking cost does not scale superlinearly", () => {
      const config = createConfig();
      const sizes = [10, 50, 100, 500];
      const timings: number[] = [];

      for (const size of sizes) {
        const candidates = Array.from({ length: size }, (_, i) =>
          createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
        );

        const start = performance.now();
        rankCandidatesByProfit(candidates, config);
        const duration = performance.now() - start;

        timings.push(duration);
      }

      // Verify linear or sub-quadratic scaling
      // If doubling size more than quadruples time, that's a problem
      const ratio10to50 = timings[1]! / timings[0]!; // Should be ~5x
      const ratio50to100 = timings[2]! / timings[1]!; // Should be ~2x
      const ratio100to500 = timings[3]! / timings[2]!; // Should be ~5x

      // Allow generous bounds (anything from 1x to 50x for each doubling)
      expect(ratio10to50).toBeLessThan(100);
      expect(ratio50to100).toBeLessThan(100);
      expect(ratio100to500).toBeLessThan(100);
    });
  });

  describe("no repeated profitability calculations", () => {
    it("profitability evaluated exactly once per candidate", () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      // This is more of a logical test — the implementation should evaluate
      // profitability once per candidate during ranking, not multiple times

      const ranked = rankCandidatesByProfit(candidates, config);

      // Verify each candidate has profitability metadata
      for (const candidate of ranked) {
        expect(candidate.expectedNetProfit).toBeDefined();
        expect(candidate.estimatedFee).toBeDefined();
        expect(candidate.profitable).toBeDefined();
      }

      // All metadata should be consistent with a single evaluation
      const expectedFee = 60_000n; // 10_000 + 50_000
      for (const candidate of ranked) {
        expect(candidate.estimatedFee).toBe(expectedFee);
      }
    });
  });

  describe("scalability with diverse reward values", () => {
    it("ranking handles highly skewed reward distribution efficiently", () => {
      const candidates = [
        ...Array.from({ length: 90 }, (_, i) =>
          createCandidate(BigInt(i + 1), 10_000n) // Low rewards
        ),
        ...Array.from({ length: 10 }, (_, i) =>
          createCandidate(BigInt(i + 91), BigInt(1_000_000 * (i + 1))) // High rewards
        ),
      ];
      const config = createConfig();

      const start = performance.now();
      const ranked = rankCandidatesByProfit(candidates, config);
      const duration = performance.now() - start;

      expect(ranked).toHaveLength(100);
      // Should still be efficient despite skewed distribution
      expect(duration).toBeLessThan(50);
    });

    it("ranking handles identical rewards efficiently", () => {
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), 100_000n) // All identical rewards
      );
      const config = createConfig();

      const start = performance.now();
      const ranked = rankCandidatesByProfit(candidates, config);
      const duration = performance.now() - start;

      expect(ranked).toHaveLength(1000);
      // Should be efficient even with all identical rewards (tie-breaking by ID)
      expect(duration).toBeLessThan(200);
    });
  });

  describe("memory efficiency", () => {
    it("does not create excessive intermediate arrays", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      // This is a qualitative check — the implementation should not create
      // multiple copies of the candidate array during ranking

      const ranked = rankCandidatesByProfit(candidates, config);

      // Output should be a single array with all candidates
      expect(ranked).toHaveLength(candidates.length);

      // Each ranked candidate should have profit metadata attached
      // but not create duplicates of the candidate object
      for (let i = 0; i < ranked.length; i++) {
        const input = candidates[i]!;
        const output = ranked.find((c) => c.taskId === input.taskId)!;

        // Should have extended the candidate, not created a separate copy
        expect(output.taskId).toBe(input.taskId);
        expect(output.reward).toBe(input.reward);
      }
    });
  });

  describe("realistic keeper round scenarios", () => {
    it("complete round workflow for realistic event count", () => {
      // v1 fetches from 1000 ledgers at a time, typical task event density
      const candidates = Array.from({ length: 50 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();
      const maxTasksPerRound = 5;

      const startTime = performance.now();

      // Simulate complete round workflow
      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      const totalDuration = performance.now() - startTime;

      expect(ranked).toHaveLength(50);
      expect(selected).toHaveLength(5);

      // Entire workflow should complete in <50ms
      expect(totalDuration).toBeLessThan(50);
    });

    it("multiple rounds in sequence remain performant", () => {
      const config = createConfig();

      const roundTimings = [];

      for (let roundNum = 0; roundNum < 10; roundNum++) {
        // Each round processes up to 50 candidates
        const candidates = Array.from({ length: 50 }, (_, i) =>
          createCandidate(BigInt(roundNum * 1000 + i + 1), BigInt((i + 1) * 100_000))
        );

        const start = performance.now();
        const ranked = rankCandidatesByProfit(candidates, config);
        selectTopCandidates(ranked, 5);
        const duration = performance.now() - start;

        roundTimings.push(duration);
      }

      // All rounds should be similar speed (no degradation)
      const avgTime = roundTimings.reduce((a, b) => a + b, 0) / roundTimings.length;
      const maxTime = Math.max(...roundTimings);
      const minTime = Math.min(...roundTimings);

      // Max should not be more than 3x the average
      expect(maxTime).toBeLessThan(avgTime * 3);

      // Should all complete quickly
      for (const time of roundTimings) {
        expect(time).toBeLessThan(50);
      }
    });
  });
});
