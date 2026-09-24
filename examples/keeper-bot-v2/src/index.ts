/**
 * Keeper Bot v2 - Advanced off-chain keeper for the Soroban Keeper Network
 *
 * This package implements a production-grade keeper bot with:
 * - Task prioritization by expected net profit (issue #0261)
 * - Real profitability checks (issue #0254)
 * - Support for future concurrency and persistence layers
 *
 * The core ranking and profitability logic is available for reuse,
 * while the loop orchestration can be integrated into various deployment
 * models (serverless, daemon, cluster).
 */

export * from "./types.js";
export * from "./profitability.js";
export * from "./ranking.js";

// Main loop and integration points will be added as v2 development progresses
