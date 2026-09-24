import { FeeConfig } from "./fees";

/**
 * Configuration for keeper-bot-v2 fee adaptation.
 * All values are read from environment variables with sensible defaults.
 */
export interface KeeperConfig {
  /** Maximum fee in stroops the operator will ever pay */
  feeCeilingStroops: number;

  /** Fee percentile to target from network stats */
  feePercentile: "p10" | "p50" | "p90" | "p99";

  /** Multiplier applied to the selected percentile */
  feeMultiplier: number;
}

/**
 * Loads keeper configuration from environment variables.
 *
 * Environment variables:
 * - FEE_CEILING_STROOPS: Maximum fee in stroops (default: 10000)
 * - FEE_PERCENTILE: Target percentile p10|p50|p90|p99 (default: p90)
 * - FEE_MULTIPLIER: Multiplier on selected percentile (default: 1.1)
 *
 * @returns Configuration object ready for use with getAdaptiveFee()
 * @throws Error if environment variables have invalid values
 */
export function loadFeeConfig(): KeeperConfig {
  const feeCeilingStroops = parseInt(
    process.env.FEE_CEILING_STROOPS ?? "10000",
    10,
  );

  if (isNaN(feeCeilingStroops) || feeCeilingStroops < 0) {
    throw new Error(
      `Invalid FEE_CEILING_STROOPS: "${process.env.FEE_CEILING_STROOPS}" is not a valid non-negative integer`,
    );
  }

  const feePercentileRaw = (process.env.FEE_PERCENTILE ?? "p90").toLowerCase();

  if (!["p10", "p50", "p90", "p99"].includes(feePercentileRaw)) {
    throw new Error(
      `Invalid FEE_PERCENTILE: "${process.env.FEE_PERCENTILE}" must be one of p10, p50, p90, p99`,
    );
  }

  const feePercentile = feePercentileRaw as "p10" | "p50" | "p90" | "p99";

  const feeMultiplier = parseFloat(process.env.FEE_MULTIPLIER ?? "1.1");

  if (isNaN(feeMultiplier) || feeMultiplier <= 0) {
    throw new Error(
      `Invalid FEE_MULTIPLIER: "${process.env.FEE_MULTIPLIER}" must be a positive number`,
    );
  }

  return {
    feeCeilingStroops,
    feePercentile,
    feeMultiplier,
  };
}

/**
 * Converts KeeperConfig to FeeConfig for use with getAdaptiveFee().
 * This is a simple wrapper that ensures type compatibility.
 *
 * @param config - Keeper configuration
 * @returns Fee configuration for the adaptive fee module
 */
export function toFeeConfig(config: KeeperConfig): FeeConfig {
  return {
    feeCeilingStroops: config.feeCeilingStroops,
    feePercentile: config.feePercentile,
    feeMultiplier: config.feeMultiplier,
  };
}
