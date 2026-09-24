/**
 * Keeper Bot v2 — Main Module Exports
 *
 * Provides the public API for the keeper-bot-v2 package.
 */

// Configuration
export type { BotConfig } from './config.js';
export { loadConfig } from './config.js';

// Secret handling
export { createRedactedConfigDump, isSensitiveKey, safeLogValue } from './secrets.js';

// Persistent state
export type { TaskOutcome, SkipDecision } from './state/schema.js';
export {
  SkipReason,
  recordTaskOutcome,
  getTaskOutcome,
  hasTaskOutcome,
  recordSkipDecision,
  getRecentSkipDecisions,
  getSkipDecisionsForTask,
  getSkipReasonStats,
  clearOldSkipDecisions,
} from './state/schema.js';

export { getDatabase, closeDatabase, isDatabaseOpen, reinitializeDatabase } from './state/database.js';

// Inspection API
export type {
  InspectTaskResult,
  InspectConfigResult,
  SkipDecisionRecord,
  InspectSkipDecisionsResult,
} from './inspect.js';

export {
  inspectTask,
  inspectConfig,
  inspectSkipDecisions,
  inspectTaskSkipDecisions,
  verifyNoSecretsInOutput,
} from './inspect.js';

// Task source abstraction — issue #0262
// Candidate discovery: IndexerTaskSource (WS feed) or RpcTaskSource (getEvents scanning).
// Source is selected by createTaskSource() based on config.
export type { CandidateTask, TaskSource, WebSocketFactory } from './task_source.js';
export { createTaskSource, IndexerTaskSource, RpcTaskSource } from './task_source.js';

// Version
export const VERSION = '0.2.0';
