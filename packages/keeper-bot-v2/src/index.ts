/** Package marker for the operator-focused keeper bot v2 service. */
export const KEEPER_BOT_V2_PACKAGE = "@soroban-keeper-network/keeper-bot-v2";

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
