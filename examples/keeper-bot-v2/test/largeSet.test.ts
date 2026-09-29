/**
 * Large candidate set tests (issue #0261)
 *
 * Validates correct behavior with realistic and edge-case candidate volumes,
 * ensuring the ranking logic scales appropriately.
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

describe("large candidate sets", () => {
  describe("realistic network event volumes", () => {
    it("processes typical round volume (50 candidates)", () => {
      const candidates = Array.from({ length: 50 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 5);

      expect(ranked).toHaveLength(50);
      expect(selected).toHaveLength(5);

      // Should rank correctly
      expect(ranked[0]!.taskId).toBe(50n);
      expect(selected[0]!.taskId).toBe(50n);
    });

    it("processes high-volume round (200 candidates)", () => {
      const candidates = Array.from({ length: 200 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 50_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 10);

      expect(ranked).toHaveLength(200);
      expect(selected).toHaveLength(10);

      // Top should be highest profit
      expect(ranked[0]!.taskId).toBe(200n);
    });

    it("processes peak-volume round (1000 candidates)", () => {
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 1_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 5);

      expect(ranked).toHaveLength(1000);
      expect(selected).toHaveLength(5);

      // Top 5 should be highest profit tasks
      expect(selected.map((c) => c.taskId)).toEqual([1000n, 999n, 998n, 997n, 996n]);
    });
  });

  describe("edge cases for large volumes", () => {
    it("handles maximum expected round volume (10k candidates)", () => {
      // Create a very large set
      const candidates = Array.from({ length: 10_000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 5);

      expect(ranked).toHaveLength(10_000);
      expect(selected).toHaveLength(5);

      // Top 5 should be the highest profits
      const topIds = selected.map((c) => c.taskId);
      expect(topIds).toContain(10_000n);
      expect(topIds).toContain(9_999n);
    });

    it("handles diverse profit distribution in large set", () => {
      const candidates = [
        // Group 1: very high profits
        ...Array.from({ length: 10 }, (_, i) =>
          createCandidate(BigInt(i + 1), 1_000_000_000n)
        ),
        // Group 2: medium profits
        ...Array.from({ length: 100 }, (_, i) =>
          createCandidate(BigInt(i + 11), 10_000_000n)
        ),
        // Group 3: low profits
        ...Array.from({ length: 890 }, (_, i) =>
          createCandidate(BigInt(i + 111), 100_000n)
        ),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 5);

      // Should select from the very high profit group
      for (const candidate of selected) {
        expect(candidate.taskId).toBeLessThanOrEqual(10n);
      }
    });

    it("handles all candidates with identical profitability in large set", () => {
      const candidates = Array.from({ length: 500 }, (_, i) =>
        createCandidate(BigInt(i + 1), 100_000n) // All identical reward
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Should be sorted by taskId (stable tie-breaking)
      for (let i = 0; i < ranked.length - 1; i++) {
        expect(ranked[i]!.taskId < ranked[i + 1]!.taskId).toBe(true);
      }
    });

    it("handles extreme profit variance in large set", () => {
      const candidates = [
        // Extreme high
        createCandidate(1n, 1_000_000_000_000_000n), // 1 quadrillion stroops
        // High
        ...Array.from({ length: 49 }, (_, i) =>
          createCandidate(BigInt(i + 2), BigInt(1_000_000 * (i + 1)))
        ),
        // Very low
        ...Array.from({ length: 450 }, (_, i) =>
          createCandidate(BigInt(i + 51), BigInt((i + 1) * 10))
        ),
        // Zero/negative
        ...Array.from({ length: 500 }, (_, i) =>
          createCandidate(BigInt(i + 501), BigInt((i + 1) % 2)) // Some will be unprofitable
        ),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      expect(ranked).toHaveLength(1000);

      // Highest profit should be first
      expect(ranked[0]!.taskId).toBe(1n);
    });
  });

  describe("budget enforcement at scale", () => {
    it("enforces small budget with large candidate set", () => {
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
      );
      const config = createConfig();
      const budget = 1; // Very restrictive budget

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, budget);

      expect(selected).toHaveLength(1);
      expect(selected[0]!.taskId).toBe(1000n);
    });

    it("enforces medium budget with large candidate set", () => {
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
      );
      const config = createConfig();
      const budget = 50;

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, budget);

      expect(selected).toHaveLength(budget);

      // Should select top 50 by profit
      const topIds = selected.map((c) => c.taskId);
      expect(topIds).toContain(1000n);
      expect(topIds).not.toContain(951n); // Below top 50
    });

    it("budget equal to candidate count selects all", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, candidates.length);

      expect(selected).toHaveLength(candidates.length);
    });

    it("budget exceeding candidate count selects all", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 10_000);

      expect(selected).toHaveLength(candidates.length);
    });
  });

  describe("correctness at scale", () => {
    it("maintains ranking order across entire large set", () => {
      const candidates = Array.from({ length: 500 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 50_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Verify strict descending order by profit
      for (let i = 0; i < ranked.length - 1; i++) {
        const current = ranked[i]!.expectedNetProfit;
        const next = ranked[i + 1]!.expectedNetProfit;

        // Current should be >= next (descending)
        expect(current >= next).toBe(true);

        // If equal, verify taskId ordering (tie-breaker)
        if (current === next) {
          expect(ranked[i]!.taskId < ranked[i + 1]!.taskId).toBe(true);
        }
      }
    });

    it("handles interleaved profitable/unprofitable candidates", () => {
      const candidates = Array.from({ length: 100 }, (_, i) => {
        const reward = BigInt(((i + 1) % 2) * 1_000_000 + 50_000); // Alternates high/low
        return createCandidate(BigInt(i + 1), reward);
      });
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const profitable = ranked.filter((c) => c.profitable);
      const unprofitable = ranked.filter((c) => !c.profitable);

      // All profitable should come before unprofitable (due to descending sort)
      const lastProfitableIdx = ranked.findIndex((c) => !c.profitable);
      const firstUnprofitableIdx = lastProfitableIdx;

      if (lastProfitableIdx > -1) {
        for (let i = 0; i < firstUnprofitableIdx; i++) {
          expect(ranked[i]!.profitable).toBe(true);
        }
        for (let i = firstUnprofitableIdx; i < ranked.length; i++) {
          expect(ranked[i]!.profitable).toBe(false);
        }
      }
    });
  });

  describe("stress tests", () => {
    it("handles rapid successive large rankings", () => {
      const config = createConfig();

      for (let iteration = 0; iteration < 5; iteration++) {
        const candidates = Array.from({ length: 500 }, (_, i) =>
          createCandidate(BigInt(iteration * 1000 + i + 1), BigInt((i + 1) * 100_000))
        );

        const ranked = rankCandidatesByProfit(candidates, config);
        expect(ranked).toHaveLength(500);
      }
    });

    it("handles multiple concurrent large selections", () => {
      const config = createConfig();
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
      );

      const ranked = rankCandidatesByProfit(candidates, config);

      const selections = [1, 5, 10, 50, 100].map((budget) =>
        selectTopCandidates(ranked, budget)
      );

      // All selections should be correct
      expect(selections[0]!).toHaveLength(1);
      expect(selections[1]!).toHaveLength(5);
      expect(selections[2]!).toHaveLength(10);
      expect(selections[3]!).toHaveLength(50);
      expect(selections[4]!).toHaveLength(100);
    });
  });
});
