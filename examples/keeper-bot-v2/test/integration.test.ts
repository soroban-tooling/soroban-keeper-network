/**
 * Integration flow tests (issue #0261)
 *
 * Tests the complete round workflow from candidate discovery through ranking
 * to selection and processing, ensuring all components work together correctly.
 */

import { describe, it, expect } from "vitest";
import { rankCandidatesByProfit, selectTopCandidates } from "../src/ranking.js";
import { evaluateAndRankCandidates } from "../src/loop.js";
import { estimateTaskProfitability } from "../src/profitability.js";
import type { EvaluatedCandidate, RankedCandidate } from "../src/types.js";
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

describe("integration workflows", () => {
  describe("complete round workflow", () => {
    it("executes full workflow: discover → evaluate → rank → select", () => {
      // Step 1: Discover candidates (simulate event discovery)
      const discovered = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];

      // Step 2: Evaluate profitability
      const config = createConfig();
      const profitChecks = discovered.map((c) => ({
        candidate: c,
        profitability: estimateTaskProfitability(c, config),
      }));

      // Step 3: Rank candidates
      const ranked = rankCandidatesByProfit(discovered, config);

      // Step 4: Select top candidates for processing
      const maxTasksPerRound = 2;
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Verify workflow results
      expect(profitChecks).toHaveLength(5);
      expect(ranked).toHaveLength(5);
      expect(selected).toHaveLength(2);

      // Verify selection is most profitable
      expect(selected[0]!.taskId).toBe(2n); // 440k profit
      expect(selected[1]!.taskId).toBe(5n); // 240k profit
    });

    it("handles profitability evaluation throughout workflow", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      // Step 1: Rank
      const ranked = rankCandidatesByProfit(candidates, config);

      // Step 2: All ranked candidates should have profitability metadata
      for (const candidate of ranked) {
        expect(candidate.profitable).toBeDefined();
        expect(candidate.expectedNetProfit).toBeDefined();
        expect(candidate.estimatedFee).toBeDefined();

        // Metadata should be consistent with profitability calculation
        const direct = estimateTaskProfitability(candidate, config);
        expect(candidate.expectedNetProfit).toBe(direct.netProfit);
        expect(candidate.profitable).toBe(direct.profitable);
      }

      // Step 3: Select
      const selected = selectTopCandidates(ranked, 1);

      // Step 4: Selected candidates retain all metadata
      expect(selected[0]!.profitable).toBe(true);
      expect(selected[0]!.expectedNetProfit).toBeGreaterThan(0n);
    });
  });

  describe("evaluateAndRankCandidates orchestration", () => {
    it("orchestrates discovery to selection correctly", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();
      const maxTasksPerRound = 2;

      const selected = evaluateAndRankCandidates(candidates, config, maxTasksPerRound);

      expect(selected).toHaveLength(2);
      expect(selected[0]!.taskId).toBe(2n);
      expect(selected[1]!.taskId).toBe(3n);
    });

    it("handles edge case: orchestration with no candidates", () => {
      const selected = evaluateAndRankCandidates([], createConfig(), 5);
      expect(selected).toHaveLength(0);
    });

    it("handles edge case: orchestration with budget of 0", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];

      const selected = evaluateAndRankCandidates(candidates, createConfig(), 0);
      expect(selected).toHaveLength(0);
    });
  });

  describe("multi-round scenarios", () => {
    it("processes consecutive rounds with varying candidate sets", () => {
      const config = createConfig();
      const results = [];

      for (let round = 0; round < 3; round++) {
        // Each round has different candidates
        const candidates = Array.from({ length: 10 }, (_, i) =>
          createCandidate(BigInt(round * 100 + i + 1), BigInt((i + 1) * 100_000))
        );

        const ranked = rankCandidatesByProfit(candidates, config);
        const selected = selectTopCandidates(ranked, 2);

        results.push({
          round,
          totalCandidates: candidates.length,
          rankedCount: ranked.length,
          selectedCount: selected.length,
          topSelected: selected[0]!.taskId,
        });
      }

      // Verify each round processed correctly
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.totalCandidates).toBe(10);
        expect(result.rankedCount).toBe(10);
        expect(result.selectedCount).toBe(2);
      }
    });

    it("round isolation: candidates don't leak between rounds", () => {
      const config = createConfig();

      // Round 1
      const round1Candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];
      const ranked1 = rankCandidatesByProfit(round1Candidates, config);
      const selected1 = selectTopCandidates(ranked1, 1);

      // Round 2
      const round2Candidates = [
        createCandidate(3n, 200_000n),
        createCandidate(4n, 300_000n),
      ];
      const ranked2 = rankCandidatesByProfit(round2Candidates, config);
      const selected2 = selectTopCandidates(ranked2, 1);

      // Verify isolation
      expect(selected1[0]!.taskId).toBe(2n);
      expect(selected2[0]!.taskId).toBe(4n);

      // Verify no cross-contamination
      expect(ranked1.map((c) => c.taskId)).toEqual([2n, 1n]);
      expect(ranked2.map((c) => c.taskId)).toEqual([4n, 3n]);
    });
  });

  describe("error handling and edge cases", () => {
    it("handles workflow with single candidate", () => {
      const candidates = [createCandidate(1n, 100_000n)];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 1);

      expect(selected).toHaveLength(1);
      expect(selected[0]!.taskId).toBe(1n);
    });

    it("handles workflow with all unprofitable candidates", () => {
      const candidates = [
        createCandidate(1n, 30_000n), // unprofitable
        createCandidate(2n, 40_000n), // unprofitable
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Should still rank (descending by profit, even if negative)
      expect(ranked).toHaveLength(2);

      // Verify ranking order by profit
      expect(ranked[0]!.expectedNetProfit).toBeGreaterThan(
        ranked[1]!.expectedNetProfit
      );

      // Selection still works
      const selected = selectTopCandidates(ranked, 1);
      expect(selected).toHaveLength(1);
    });

    it("handles workflow with mixed profit scenarios", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // profitable
        createCandidate(2n, 30_000n), // unprofitable
        createCandidate(3n, 150_000n), // profitable
        createCandidate(4n, 20_000n), // unprofitable
        createCandidate(5n, 200_000n), // profitable
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 2);

      // Should select the two most profitable (regardless of overall profitability)
      expect(selected[0]!.taskId).toBe(5n); // 140k profit
      expect(selected[1]!.taskId).toBe(3n); // 90k profit
    });
  });

  describe("consistency across workflows", () => {
    it("repeated workflows produce identical results", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      const results = Array.from({ length: 5 }, () => {
        const ranked = rankCandidatesByProfit(candidates, config);
        const selected = selectTopCandidates(ranked, 1);
        return selected[0]!.taskId;
      });

      // All results should be identical
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(2n);
    });

    it("workflow result consistency independent of implementation detail", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      // Method A: manual workflow
      const ranked = rankCandidatesByProfit(candidates, config);
      const selectedA = selectTopCandidates(ranked, 2);

      // Method B: using orchestration function
      const selectedB = evaluateAndRankCandidates(candidates, config, 2);

      // Should produce identical results
      expect(selectedA.map((c) => c.taskId)).toEqual(selectedB.map((c) => c.taskId));
    });
  });

  describe("acceptance criteria verification", () => {
    it("AC#1: candidates are ranked before processing", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // Arrives first
        createCandidate(2n, 500_000n), // Arrives second
        createCandidate(3n, 150_000n), // Arrives third
      ];

      // Before ranking: arrival order
      const arrivalOrder = candidates.map((c) => c.taskId);
      expect(arrivalOrder).toEqual([1n, 2n, 3n]);

      // After ranking: profit order
      const config = createConfig();
      const ranked = rankCandidatesByProfit(candidates, config);
      const rankingOrder = ranked.map((c) => c.taskId);

      // Should be different (profit order, not arrival order)
      expect(rankingOrder).not.toEqual(arrivalOrder);
      expect(rankingOrder).toEqual([2n, 3n, 1n]); // By profit: 440k, 90k, 40k
    });

    it("AC#2: round with budget processes most profitable candidates first", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000
        createCandidate(2n, 500_000n), // profit: 440_000
        createCandidate(3n, 150_000n), // profit: 90_000
        createCandidate(4n, 75_000n), // profit: 15_000
        createCandidate(5n, 300_000n), // profit: 240_000
      ];
      const config = createConfig();
      const maxTasksPerRound = 2; // Cannot process all

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Should select the two highest profit candidates
      const selectedTaskIds = selected.map((c) => c.taskId);
      expect(selectedTaskIds).toEqual([2n, 5n]);

      // Should NOT select lower profit candidates
      expect(selectedTaskIds).not.toContain(3n);
      expect(selectedTaskIds).not.toContain(1n);
      expect(selectedTaskIds).not.toContain(4n);
    });

    it("AC#3: ranking does not introduce excessive latency", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      const startTime = performance.now();
      const ranked = rankCandidatesByProfit(candidates, config);
      const endTime = performance.now();

      const rankingLatencyMs = endTime - startTime;

      // Should complete in well under 10ms (1% of typical 1s round time)
      expect(rankingLatencyMs).toBeLessThan(10);

      // Verify ranking still correct
      expect(ranked).toHaveLength(100);
      expect(ranked[0]!.taskId).toBe(100n);
    });
  });
});
