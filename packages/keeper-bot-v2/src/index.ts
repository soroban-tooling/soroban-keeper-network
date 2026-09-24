/** Package marker for the operator-focused keeper bot v2 service. */
export const KEEPER_BOT_V2_PACKAGE = "@soroban-keeper-network/keeper-bot-v2";

export {
  claimIfProfitable,
  estimateTaskProfitability,
  type ProfitabilityDecision,
  type ProfitabilityInputs,
} from "./profitability.js";
export {
  loadProfitabilityConfig,
  requireEnv,
  type ProfitabilityConfig,
} from "./config.js";
export {
  ExecutorRegistry,
  dispatchTask,
} from "./executors/interface.js";
export type {
  ExecuteContext,
  ExecutorEstimate,
  KeeperTask,
  TaskExecutor,
} from "./executors/interface.js";
export {
  loadExecutorModules,
  parseExecutorModuleList,
} from "./executors/loader.js";
export { ttlExtensionExecutor } from "./executors/ttl-extension.js";
export {
  KeeperMetrics,
  SKIP_REASONS,
  startMetricsServer,
  type SkipReason,
} from "./metrics.js";
