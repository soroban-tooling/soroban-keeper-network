import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorobanRpc } from "@stellar/stellar-sdk";
import {
  getAdaptiveFee,
  isOperationProfitable,
  BASE_FEE,
  FeeConfig,
  FeeEstimate,
} from "./fees";

// Mock SorobanRpc.Server type
const createMockServer = (
  getFeeStatsResponse?: SorobanRpc.Api.GetFeeStatsResponse | null,
  shouldThrow?: boolean,
): SorobanRpc.Server => {
  return {
    getFeeStats: vi.fn(async () => {
      if (shouldThrow) {
        throw new Error("RPC unavailable");
      }
      return getFeeStatsResponse || ({} as SorobanRpc.Api.GetFeeStatsResponse);
    }),
  } as unknown as SorobanRpc.Server;
};

describe("getAdaptiveFee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a) adapts to network p90 fee within ceiling", async () => {
    // Mock server returning p90 = 500 stroops
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        p90: 500,
        p99: 800,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(500);
    expect(estimate.adaptedFromNetwork).toBe(true);
    expect(estimate.networkFeeRaw).toBe(500);
    expect(estimate.ceilingApplied).toBe(false);
  });

  it("b) applies multiplier to selected percentile", async () => {
    // Mock server returning p90 = 500 stroops
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        p90: 500,
        p99: 800,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 1.2,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    // 500 * 1.2 = 600
    expect(estimate.recommendedFee).toBe(600);
    expect(estimate.adaptedFromNetwork).toBe(true);
    expect(estimate.networkFeeRaw).toBe(500);
    expect(estimate.ceilingApplied).toBe(false);
  });

  it("c) clamps fee to ceiling when network fee exceeds it", async () => {
    // Mock server returning p90 = 15000 stroops (above ceiling)
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 12000,
        p50: 14000,
        p90: 15000,
        p99: 20000,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(10000);
    expect(estimate.adaptedFromNetwork).toBe(true);
    expect(estimate.networkFeeRaw).toBe(15000);
    expect(estimate.ceilingApplied).toBe(true);
  });

  it("d) falls back to BASE_FEE when RPC is unavailable", async () => {
    const mockServer = createMockServer(null, true);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(BASE_FEE);
    expect(estimate.adaptedFromNetwork).toBe(false);
    expect(estimate.ceilingApplied).toBe(false);
  });

  it("e) falls back when fee stats are malformed (missing percentile)", async () => {
    // Mock server returning empty or incomplete fee stats
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        // p90 is missing
        p99: 800,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(BASE_FEE);
    expect(estimate.adaptedFromNetwork).toBe(false);
  });

  it("f) never returns below BASE_FEE even when network fee is lower", async () => {
    // Mock server returning p90 = 50 stroops (below BASE_FEE = 100)
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 30,
        p50: 40,
        p90: 50,
        p99: 80,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBeGreaterThanOrEqual(BASE_FEE);
    expect(estimate.recommendedFee).toBe(BASE_FEE);
    expect(estimate.adaptedFromNetwork).toBe(false);
  });

  it("g) throws when ceiling is below BASE_FEE", async () => {
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        p90: 500,
        p99: 800,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 50, // Below BASE_FEE
      feePercentile: "p90",
      feeMultiplier: 1.0,
    };

    await expect(getAdaptiveFee(mockServer, config)).rejects.toThrow(
      /feeCeilingStroops.*must be >= BASE_FEE/,
    );
  });

  it("h) uses different percentile when configured (p50)", async () => {
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        p90: 500,
        p99: 800,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p50",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(300);
    expect(estimate.networkFeeRaw).toBe(300);
  });

  it("i) uses p99 percentile when configured (extreme inclusion priority)", async () => {
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        p90: 500,
        p99: 800,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p99",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(800);
    expect(estimate.networkFeeRaw).toBe(800);
  });

  it("j) ceiling prevents fee from exceeding operator limit even during extreme congestion", async () => {
    // Simulate extreme network congestion: p99 = 1_000_000 stroops
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 900000,
        p50: 950000,
        p90: 980000,
        p99: 1000000,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000, // Operator's hard limit
      feePercentile: "p99",
      feeMultiplier: 1.0,
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    expect(estimate.recommendedFee).toBe(10000);
    expect(estimate.ceilingApplied).toBe(true);
    expect(estimate.networkFeeRaw).toBe(1000000);
  });

  it("k) applies ceiling after multiplier", async () => {
    const mockServer = createMockServer({
      sorobanInclusionFee: {
        p10: 100,
        p50: 300,
        p90: 5000,
        p99: 8000,
      },
    } as unknown as SorobanRpc.Api.GetFeeStatsResponse);

    const config: FeeConfig = {
      feeCeilingStroops: 10000,
      feePercentile: "p90",
      feeMultiplier: 2.5, // 5000 * 2.5 = 12500
    };

    const estimate = await getAdaptiveFee(mockServer, config);

    // 5000 * 2.5 = 12500, clamped to 10000
    expect(estimate.recommendedFee).toBe(10000);
    expect(estimate.ceilingApplied).toBe(true);
    expect(estimate.networkFeeRaw).toBe(5000);
  });
});

describe("isOperationProfitable", () => {
  it("h) returns true when profit exceeds fee", () => {
    const feeEstimate: FeeEstimate = {
      recommendedFee: 100,
      adaptedFromNetwork: true,
      networkFeeRaw: 100,
      ceilingApplied: false,
    };

    const grossProfit = 1000n;

    expect(isOperationProfitable(grossProfit, feeEstimate)).toBe(true);
  });

  it("i) returns false when fee exceeds profit", () => {
    const feeEstimate: FeeEstimate = {
      recommendedFee: 100,
      adaptedFromNetwork: true,
      networkFeeRaw: 100,
      ceilingApplied: false,
    };

    const grossProfit = 50n;

    expect(isOperationProfitable(grossProfit, feeEstimate)).toBe(false);
  });

  it("j) uses actual fee from estimate, not BASE_FEE constant", () => {
    // This test ensures the profitability check uses the ACTUAL adaptive fee,
    // not the hardcoded BASE_FEE assumption.
    // grossProfit = 150, adaptedFee = 200 (above BASE_FEE=100)
    // If the check incorrectly used BASE_FEE=100, it would return true
    // But with the correct adaptedFee, it returns false

    const feeEstimate: FeeEstimate = {
      recommendedFee: 200, // Adaptive fee above BASE_FEE
      adaptedFromNetwork: true,
      networkFeeRaw: 200,
      ceilingApplied: false,
    };

    const grossProfit = 150n;

    // Must be false because 150 - 200 = -50 (negative net profit)
    expect(isOperationProfitable(grossProfit, feeEstimate)).toBe(false);

    // If the check had incorrectly used BASE_FEE (100), it would have been true
    // This demonstrates we're using the actual fee, not the constant
    const incorrectCheckWithBaseFee = grossProfit > BigInt(BASE_FEE);
    expect(incorrectCheckWithBaseFee).toBe(true); // This would be wrong
  });

  it("k) returns false when profit equals fee (net profit is zero)", () => {
    const feeEstimate: FeeEstimate = {
      recommendedFee: 100,
      adaptedFromNetwork: true,
      networkFeeRaw: 100,
      ceilingApplied: false,
    };

    const grossProfit = 100n;

    // Net profit would be 0, which is not > 0, so false
    expect(isOperationProfitable(grossProfit, feeEstimate)).toBe(false);
  });

  it("l) handles large values correctly", () => {
    const feeEstimate: FeeEstimate = {
      recommendedFee: 1000000,
      adaptedFromNetwork: true,
      networkFeeRaw: 1000000,
      ceilingApplied: false,
    };

    const grossProfit = 2000000n;

    expect(isOperationProfitable(grossProfit, feeEstimate)).toBe(true);
  });
});
