import { SorobanRpc } from "@stellar/stellar-sdk";

/**
 * Adaptive fee module for keeper-bot-v2.
 *
 * Queries current network fee conditions via Soroban RPC and returns
 * a fee that adapts to congestion, bounded by the operator's ceiling.
 *
 * Fee selection strategy:
 * - Use the p90 fee from recent ledgers (pays better than median,
 *   competitive without wildly overpaying during spikes)
 * - Apply a configurable multiplier for urgency (default 1.0)
 * - Clamp to FEE_CEILING — never exceed operator's limit
 * - Fall back to BASE_FEE if RPC fee stats are unavailable
 */

/** Minimum acceptable fee in stroops (Stellar base fee) */
export const BASE_FEE = 100;

export interface FeeConfig {
  /**
   * Maximum fee in stroops the operator will ever pay.
   * Adaptive fee is clamped to this value regardless of network conditions.
   * Recommended: 10_000 stroops for normal operations.
   */
  feeCeilingStroops: number;

  /**
   * Fee percentile to target from recent ledger stats.
   * p90 = pay more than 90% of recent transactions (high inclusion probability)
   * p50 = median fee (lower cost, moderate inclusion probability)
   */
  feePercentile?: "p10" | "p50" | "p90" | "p99";

  /**
   * Multiplier applied to the selected percentile fee.
   * 1.0 = exact percentile, 1.2 = 20% above to improve inclusion odds.
   */
  feeMultiplier?: number;
}

export interface FeeEstimate {
  /** The fee that will be submitted, in stroops */
  recommendedFee: number;

  /** Whether the fee was adapted from network conditions (true) or fell back to BASE_FEE (false) */
  adaptedFromNetwork: boolean;

  /** The raw network p90 fee before multiplier and ceiling, for diagnostics */
  networkFeeRaw?: number;

  /** Whether the ceiling was applied (fee was clamped) */
  ceilingApplied: boolean;
}

/**
 * Queries Soroban RPC for current fee conditions and returns an adaptive fee.
 *
 * Falls back to BASE_FEE if:
 * - RPC is unavailable
 * - Fee stats are missing or malformed
 * - Network fee is lower than BASE_FEE
 *
 * @param server - Soroban RPC server instance
 * @param config - Fee configuration including ceiling
 * @returns Fee estimate with the recommended fee and diagnostic metadata
 */
export async function getAdaptiveFee(
  server: SorobanRpc.Server,
  config: FeeConfig,
): Promise<FeeEstimate> {
  const { feeCeilingStroops, feePercentile = "p90", feeMultiplier = 1.0 } = config;

  // Validate ceiling
  if (feeCeilingStroops < BASE_FEE) {
    throw new Error(
      `feeCeilingStroops (${feeCeilingStroops}) must be >= BASE_FEE (${BASE_FEE})`,
    );
  }

  let feeStats: SorobanRpc.Api.GetFeeStatsResponse | null = null;

  try {
    feeStats = await server.getFeeStats();
  } catch (err) {
    // RPC unavailable — fall back to BASE_FEE
    console.warn("[fees] getFeeStats unavailable, falling back to BASE_FEE", err);
    return {
      recommendedFee: BASE_FEE,
      adaptedFromNetwork: false,
      ceilingApplied: false,
    };
  }

  // Extract the selected percentile fee from recent fee stats
  // Soroban RPC getFeeStats returns sorobanInclusionFee with percentile breakdowns
  const networkFeeRaw = extractPercentileFee(feeStats, feePercentile);

  if (!networkFeeRaw || networkFeeRaw <= 0) {
    return {
      recommendedFee: BASE_FEE,
      adaptedFromNetwork: false,
      networkFeeRaw,
      ceilingApplied: false,
    };
  }

  // Apply multiplier
  const withMultiplier = Math.ceil(networkFeeRaw * feeMultiplier);

  // Clamp to ceiling
  const ceilingApplied = withMultiplier > feeCeilingStroops;

  const recommendedFee = Math.max(
    BASE_FEE,
    Math.min(withMultiplier, feeCeilingStroops),
  );

  return {
    recommendedFee,
    adaptedFromNetwork: true,
    networkFeeRaw,
    ceilingApplied,
  };
}

/**
 * Extracts a specific percentile fee from Soroban RPC fee stats.
 */
function extractPercentileFee(
  feeStats: SorobanRpc.Api.GetFeeStatsResponse,
  percentile: "p10" | "p50" | "p90" | "p99",
): number | null {
  try {
    // getFeeStats returns sorobanInclusionFee with percentile fields
    const sorobanFee = (feeStats as Record<string, unknown>).sorobanInclusionFee as
      | Record<string, unknown>
      | undefined;

    if (!sorobanFee) return null;

    const rawValue = sorobanFee[percentile];

    if (rawValue === undefined || rawValue === null) return null;

    return Number(rawValue);
  } catch {
    return null;
  }
}

/**
 * Integrates adaptive fee with the profitability check.
 *
 * The profitability check (issue #254) must use the ACTUAL fee about
 * to be paid, not a hardcoded BASE_FEE assumption.
 *
 * @param grossProfit - Expected gross profit from the keeper operation (stroops)
 * @param feeEstimate - Fee estimate from getAdaptiveFee()
 * @returns Whether the operation is profitable net of the actual fee
 */
export function isOperationProfitable(
  grossProfit: bigint,
  feeEstimate: FeeEstimate,
): boolean {
  const netProfit = grossProfit - BigInt(feeEstimate.recommendedFee);
  return netProfit > 0n;
}
