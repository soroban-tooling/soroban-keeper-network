"use strict";

const { loadConfig } = require("./config.js");
const { MetricsCollector, metrics } = require("./metrics.js");
const { TaskStatus, TaskStateRegistry } = require("./state.js");
const {
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
  estimateTaskProfitability,
} = require("./profitability.js");
const { prioritizeCandidates } = require("./prioritization.js");
const {
  TASK_TYPE_NAMES,
  EXECUTORS,
  ttlExtensionExecutor,
  simulatedExecutor,
  executeTaskOffChain,
} = require("./executors.js");
const {
  DEFAULT_MAX_ROUND_SPEND_STROOPS,
  isLostClaimRaceError,
  isPermanentError,
  runKeeperRound,
} = require("./loop.js");

async function main() {
  const config = loadConfig();
  console.log("Starting Soroban Keeper Bot v2 with configuration:");
  console.log(`  RPC URL: ${config.rpcUrl}`);
  console.log(`  Contract ID: ${config.contractId}`);
  console.log(`  Max Round Spend Ceiling: ${config.maxRoundSpendStroops} stroops`);
  console.log(`  Concurrency Limit: ${config.maxConcurrency}`);
  console.log(`  Min Profit Margin: ${config.minProfitMarginStroops} stroops`);
  console.log(`  Simulate Execution: ${config.simulateExecution}`);
  console.log("\nNote: Verifier-aware proof generation is deferred until on-chain contract support lands (Issue #412).");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  MetricsCollector,
  metrics,
  TaskStatus,
  TaskStateRegistry,
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
  estimateTaskProfitability,
  prioritizeCandidates,
  TASK_TYPE_NAMES,
  EXECUTORS,
  ttlExtensionExecutor,
  simulatedExecutor,
  executeTaskOffChain,
  DEFAULT_MAX_ROUND_SPEND_STROOPS,
  isLostClaimRaceError,
  isPermanentError,
  runKeeperRound,
};
