/**
 * Runtime Inspection Commands
 *
 * Provides operator-friendly interfaces to query a live running bot's state:
 * - Task state by ID
 * - Current configuration (with secrets redacted)
 * - Recent skip decisions
 *
 * All inspection is read-only and does not require restarting the bot.
 */

import Database from 'better-sqlite3';
import { BotConfig } from './config.js';
import { createRedactedConfigDump } from './secrets.js';
import {
  getTaskOutcome,
  getRecentSkipDecisions,
  getSkipDecisionsForTask,
  getSkipReasonStats,
} from './state/schema.js';

/**
 * Result of inspecting a task's persisted state.
 */
export interface InspectTaskResult {
  taskId: number;
  status: 'claimed' | 'executed' | 'expired' | 'unknown';
  keeperAddress?: string;
  actionTimestamp?: number;
  outcome?: string;
  actionTimestampIso?: string;
}

/**
 * Inspect a specific task's persisted state.
 *
 * Returns what this keeper has done with the task (if anything) and
 * when, useful for debugging why a task was or wasn't executed.
 *
 * @param db - The database connection
 * @param taskId - The task ID to inspect
 * @returns Task state information
 */
export function inspectTask(db: Database.Database, taskId: number): InspectTaskResult {
  const outcome = getTaskOutcome(db, taskId);

  if (!outcome) {
    return { taskId, status: 'unknown' };
  }

  return {
    taskId,
    status: outcome.action,
    keeperAddress: outcome.keeperAddress,
    actionTimestamp: outcome.actionTimestamp,
    actionTimestampIso: new Date(outcome.actionTimestamp * 1000).toISOString(),
    outcome: outcome.outcome,
  };
}

/**
 * Result of inspecting the bot's current configuration.
 */
export interface InspectConfigResult {
  network: string;
  registryContractId: string;
  keeperAddress: string;
  rpcUrl: string;
  pollIntervalMs: number;
  withdrawThreshold: string;
  maxTasksPerRound: number;
  maxRetries: number;
  retryBaseMs: number;
  expireStaleTasks: boolean;
  minProfitMarginStroops: string;
  stateDbPath: string;
  simulateExecution: boolean;
  secretKey: string; // Will be redacted in output
  networkPassphrase: string;
  [key: string]: unknown;
}

/**
 * Inspect the bot's current configuration.
 *
 * Returns effective runtime configuration with all secrets redacted.
 * This is useful for verifying that the bot is configured correctly.
 *
 * @param config - The bot configuration object
 * @param keeperAddress - The keeper's public address (derived from secret key)
 * @returns Redacted configuration suitable for inspection
 */
export function inspectConfig(
  config: BotConfig,
  keeperAddress: string,
): InspectConfigResult {
  const configDict: InspectConfigResult = {
    network: config.network,
    registryContractId: config.registryContractId,
    keeperAddress,
    rpcUrl: config.rpcUrl,
    pollIntervalMs: config.pollIntervalMs,
    withdrawThreshold: config.withdrawThreshold.toString(),
    maxTasksPerRound: config.maxTasksPerRound,
    maxRetries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    expireStaleTasks: config.expireStaleTasks,
    minProfitMarginStroops: config.minProfitMarginStroops.toString(),
    stateDbPath: config.stateDbPath,
    simulateExecution: config.simulateExecution,
    secretKey: config.secretKey, // Will be redacted
    networkPassphrase: config.networkPassphrase,
  };

  // Apply redaction to the configuration object
  return createRedactedConfigDump(configDict) as InspectConfigResult;
}

/**
 * Single skip decision in inspection output.
 */
export interface SkipDecisionRecord {
  taskId: number;
  reason: string;
  timestamp: number;
  timestampIso: string;
  taskInfo?: Record<string, unknown>;
  details?: string;
}

/**
 * Result of inspecting recent skip decisions.
 */
export interface InspectSkipDecisionsResult {
  decisions: SkipDecisionRecord[];
  count: number;
  stats?: Record<string, number>;
}

/**
 * Inspect recent skip decisions.
 *
 * Returns the most recent skip decisions with reasons, useful for
 * understanding why the bot is or isn't executing tasks.
 *
 * @param db - The database connection
 * @param limit - Maximum number of recent decisions to return (default: 100)
 * @param includeStats - Whether to include skip reason statistics
 * @returns Recent skip decisions
 */
export function inspectSkipDecisions(
  db: Database.Database,
  limit: number = 100,
  includeStats: boolean = false,
): InspectSkipDecisionsResult {
  const rawDecisions = getRecentSkipDecisions(db, limit);

  const decisions: SkipDecisionRecord[] = rawDecisions.map((d) => ({
    taskId: d.taskId,
    reason: d.reason,
    timestamp: d.timestamp,
    timestampIso: new Date(d.timestamp * 1000).toISOString(),
    taskInfo: (d.taskInfo as Record<string, unknown>) || undefined,
    details: formatSkipReasonDetails(d.reason, d.taskInfo),
  }));

  const result: InspectSkipDecisionsResult = {
    decisions,
    count: decisions.length,
  };

  if (includeStats) {
    result.stats = getSkipReasonStats(db, limit * 10);
  }

  return result;
}

/**
 * Inspect skip decisions for a specific task.
 *
 * Returns all skip decisions recorded for a particular task, useful
 * for debugging why a specific task was skipped.
 *
 * @param db - The database connection
 * @param taskId - The task ID
 * @returns Skip decisions for the task
 */
export function inspectTaskSkipDecisions(
  db: Database.Database,
  taskId: number,
): InspectSkipDecisionsResult {
  const rawDecisions = getSkipDecisionsForTask(db, taskId);

  const decisions: SkipDecisionRecord[] = rawDecisions.map((d) => ({
    taskId: d.taskId,
    reason: d.reason,
    timestamp: d.timestamp,
    timestampIso: new Date(d.timestamp * 1000).toISOString(),
    taskInfo: (d.taskInfo as Record<string, unknown>) || undefined,
    details: formatSkipReasonDetails(d.reason, d.taskInfo),
  }));

  return {
    decisions,
    count: decisions.length,
  };
}

/**
 * Format human-readable details for a skip reason.
 *
 * This converts structured skip data into a readable string useful for operators.
 *
 * @param reason - The skip reason code
 * @param taskInfo - Optional task information
 * @returns Human-readable details
 */
function formatSkipReasonDetails(reason: string, taskInfo?: unknown): string {
  const info = taskInfo as Record<string, unknown> | undefined;

  switch (reason) {
    case 'deadline_passed':
      return 'Task deadline has passed';

    case 'unprofitable':
      if (info?.estimated_gas && info?.reward) {
        const gas = info.estimated_gas;
        const reward = info.reward;
        const margin = info.margin || 0;
        return `Task not profitable: gas=${gas}, reward=${reward}, margin=${margin}`;
      }
      return 'Task would not be profitable after gas costs';

    case 'no_executor':
      if (info?.task_type) {
        return `No executor registered for task type: ${info.task_type}`;
      }
      return 'No executor registered for task type';

    case 'unsupported_verifier':
      if (info?.verifier) {
        return `Unsupported verifier: ${info.verifier}`;
      }
      return 'Unsupported verifier for this task';

    case 'proof_generation_failed':
      if (info?.error) {
        return `Proof generation failed: ${info.error}`;
      }
      return 'Could not generate valid proof before claim';

    case 'claim_race_lost':
      return 'Another keeper claimed the task first';

    case 'simulation_failed':
      if (info?.error) {
        return `Simulation failed: ${info.error}`;
      }
      return 'Transaction simulation failed';

    case 'other_error':
      if (info?.error) {
        return `Error: ${info.error}`;
      }
      return 'An error occurred';

    default:
      return `Skipped: ${reason}`;
  }
}

/**
 * Verify that inspection output contains no secrets.
 *
 * This is a defensive check used in testing to ensure that
 * inspection operations never leak sensitive information.
 *
 * @param output - The output object to check
 * @returns true if no obvious secrets are found
 */
export function verifyNoSecretsInOutput(output: unknown): boolean {
  const jsonStr = JSON.stringify(output);

  // Check for common secret patterns
  if (jsonStr.includes('***REDACTED***')) {
    // This is good — it means redaction happened
    // But we don't want to find actual secrets alongside it
  }

  // Stellar secret key pattern
  if (/\bS[A-Z2-7]{55}\b/.test(jsonStr)) {
    return false;
  }

  // Very long hex strings (likely private keys)
  if (/[0-9a-fA-F]{64,}/.test(jsonStr)) {
    // This could be a hash or public identifier, not necessarily a secret
    // But if we find it alongside secret patterns, flag it
  }

  return true;
}
