/**
 * Persistent State Schema and Migrations
 *
 * Defines the SQLite schema for tracking task outcomes and skip decisions.
 * This is the durable version of v1's in-memory taskOutcomes Map.
 *
 * Schema migrations are supported from the start, following the indexer's
 * migration pattern (issue #0232) rather than inventing a second mechanism.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

/**
 * Current schema version. Increment this when making breaking schema changes.
 * Migrations are applied based on comparing this version with the DB's stored version.
 */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Initialize or migrate the database schema.
 *
 * Creates tables if they don't exist, and runs any pending migrations.
 * This function is idempotent and can be called multiple times safely.
 *
 * @param dbPath - Path to the SQLite database file
 * @returns An initialized Database instance
 */
export function initializeSchema(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable foreign keys (good practice for SQLite)
  db.pragma('foreign_keys = ON');

  // Create or check the schema version table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 1,
      migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Get the current schema version from the database
  const versionRow = db
    .prepare('SELECT version FROM _schema_version WHERE id = 1')
    .get() as { version: number } | undefined;

  const dbVersion = versionRow?.version ?? 0;

  // Run migrations if needed
  if (dbVersion < 1) {
    applyMigrationV1(db);
    db.prepare('INSERT OR REPLACE INTO _schema_version (id, version) VALUES (1, 1)').run();
  }

  return db;
}

/**
 * Migration to v1: Create base schema for task outcomes and skip decisions.
 *
 * This migration defines:
 * 1. task_outcomes: tracking what actions this keeper has taken on each task
 * 2. skip_decisions: recording reasons tasks were skipped
 */
function applyMigrationV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_outcomes (
      task_id INTEGER PRIMARY KEY,
      keeper_address TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('claimed', 'executed', 'expired')),
      action_timestamp INTEGER NOT NULL,
      outcome TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_outcomes_updated_at
      ON task_outcomes(updated_at DESC);

    CREATE TABLE IF NOT EXISTS skip_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      task_info TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skip_decisions_timestamp
      ON skip_decisions(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_skip_decisions_task_id
      ON skip_decisions(task_id);
  `);
}

/**
 * Task outcome record as stored in the database.
 */
export interface TaskOutcome {
  taskId: number;
  keeperAddress: string;
  action: 'claimed' | 'executed' | 'expired';
  actionTimestamp: number; // Unix timestamp in seconds
  outcome?: string;
  updatedAt: number; // Unix timestamp in milliseconds
}

/**
 * Skip decision record as stored in the database.
 */
export interface SkipDecision {
  id: number;
  taskId: number;
  reason: string;
  taskInfo?: unknown;
  timestamp: number; // Unix timestamp in seconds
}

/**
 * Reason codes for skipping a task.
 * These are the documented skip reasons operators should expect to see.
 */
export enum SkipReason {
  DEADLINE_PASSED = 'deadline_passed',
  UNPROFITABLE = 'unprofitable',
  NO_EXECUTOR = 'no_executor',
  UNSUPPORTED_VERIFIER = 'unsupported_verifier',
  PROOF_GENERATION_FAILED = 'proof_generation_failed',
  CLAIM_RACE_LOST = 'claim_race_lost',
  SIMULATION_FAILED = 'simulation_failed',
  OTHER_ERROR = 'other_error',
}

/**
 * Record a task outcome in persistent state.
 *
 * This is called after an action on a task (claimed, executed, or expired)
 * to mark the outcome in persistent storage. If a previous outcome exists
 * for this task, it is updated (allowing transitions like claimed → executed).
 *
 * @param db - The database connection
 * @param taskId - The task ID
 * @param keeperAddress - The keeper's Soroban address
 * @param action - The action taken (claimed, executed, expired)
 * @param outcome - Optional outcome details (success, error message, etc.)
 */
export function recordTaskOutcome(
  db: Database.Database,
  taskId: number,
  keeperAddress: string,
  action: 'claimed' | 'executed' | 'expired',
  outcome?: string,
): void {
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `
    INSERT INTO task_outcomes (task_id, keeper_address, action, action_timestamp, outcome, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      action = excluded.action,
      action_timestamp = excluded.action_timestamp,
      outcome = excluded.outcome,
      updated_at = excluded.updated_at
  `,
  ).run(taskId, keeperAddress, action, now, outcome || null, Date.now());
}

/**
 * Get the persisted outcome for a specific task.
 *
 * @param db - The database connection
 * @param taskId - The task ID to query
 * @returns The task outcome if found, or undefined
 */
export function getTaskOutcome(db: Database.Database, taskId: number): TaskOutcome | undefined {
  const row = db
    .prepare('SELECT * FROM task_outcomes WHERE task_id = ?')
    .get(taskId) as Record<string, unknown> | undefined;

  if (!row) {
    return undefined;
  }

  return {
    taskId: row.task_id as number,
    keeperAddress: row.keeper_address as string,
    action: row.action as 'claimed' | 'executed' | 'expired',
    actionTimestamp: row.action_timestamp as number,
    outcome: (row.outcome as string | null) || undefined,
    updatedAt: row.updated_at as number,
  };
}

/**
 * Check if a task has been previously interacted with by this keeper.
 *
 * @param db - The database connection
 * @param taskId - The task ID
 * @returns true if the task is in the outcomes table
 */
export function hasTaskOutcome(db: Database.Database, taskId: number): boolean {
  const row = db
    .prepare('SELECT 1 FROM task_outcomes WHERE task_id = ?')
    .get(taskId) as Record<string, unknown> | undefined;

  return row !== undefined;
}

/**
 * Record a skip decision in persistent state.
 *
 * This is called when a task is skipped (for any reason) to maintain
 * an audit trail of why tasks were not executed.
 *
 * @param db - The database connection
 * @param taskId - The task ID
 * @param reason - The reason for skipping (see SkipReason enum)
 * @param taskInfo - Optional details about the task (reward, deadline, etc.)
 */
export function recordSkipDecision(
  db: Database.Database,
  taskId: number,
  reason: string,
  taskInfo?: unknown,
): void {
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `
    INSERT INTO skip_decisions (task_id, reason, task_info, timestamp)
    VALUES (?, ?, ?, ?)
  `,
  ).run(taskId, reason, taskInfo ? JSON.stringify(taskInfo) : null, now);
}

/**
 * Get recent skip decisions.
 *
 * Returns skip decisions ordered by most recent first.
 *
 * @param db - The database connection
 * @param limit - Maximum number of skip decisions to return (default: 100)
 * @returns Array of skip decisions
 */
export function getRecentSkipDecisions(
  db: Database.Database,
  limit: number = 100,
): Array<SkipDecision & { taskInfo: unknown }> {
  const rows = db
    .prepare(
      `
      SELECT id, task_id, reason, task_info, timestamp
      FROM skip_decisions
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    taskId: row.task_id as number,
    reason: row.reason as string,
    taskInfo: row.task_info ? JSON.parse(row.task_info as string) : undefined,
    timestamp: row.timestamp as number,
  }));
}

/**
 * Get skip decisions for a specific task.
 *
 * Useful for understanding why a particular task was skipped multiple times.
 *
 * @param db - The database connection
 * @param taskId - The task ID
 * @returns Array of skip decisions for the task
 */
export function getSkipDecisionsForTask(
  db: Database.Database,
  taskId: number,
): Array<SkipDecision & { taskInfo: unknown }> {
  const rows = db
    .prepare(
      `
      SELECT id, task_id, reason, task_info, timestamp
      FROM skip_decisions
      WHERE task_id = ?
      ORDER BY timestamp DESC
    `,
    )
    .all(taskId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    taskId: row.task_id as number,
    reason: row.reason as string,
    taskInfo: row.task_info ? JSON.parse(row.task_info as string) : undefined,
    timestamp: row.timestamp as number,
  }));
}

/**
 * Get skip reason statistics (count by reason code).
 *
 * Useful for understanding what types of skip reasons are most common.
 *
 * @param db - The database connection
 * @param limit - Maximum number of most recent decisions to analyze (default: 1000)
 * @returns Object mapping reason codes to counts
 */
export function getSkipReasonStats(
  db: Database.Database,
  limit: number = 1000,
): Record<string, number> {
  const rows = db
    .prepare(
      `
      SELECT reason, COUNT(*) as count
      FROM (
        SELECT reason FROM skip_decisions
        ORDER BY timestamp DESC
        LIMIT ?
      )
      GROUP BY reason
      ORDER BY count DESC
    `,
    )
    .all(limit) as Array<Record<string, unknown>>;

  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.reason as string] = row.count as number;
  }

  return stats;
}

/**
 * Clear old skip decisions (for maintenance/hygiene).
 *
 * Removes skip decisions older than the specified number of seconds.
 * This is useful to prevent the skip_decisions table from growing unbounded.
 *
 * @param db - The database connection
 * @param olderThanSeconds - Delete decisions older than this many seconds (default: 7 days)
 * @returns Number of rows deleted
 */
export function clearOldSkipDecisions(
  db: Database.Database,
  olderThanSeconds: number = 7 * 24 * 60 * 60,
): number {
  const cutoffTime = Math.floor(Date.now() / 1000) - olderThanSeconds;

  const result = db
    .prepare('DELETE FROM skip_decisions WHERE timestamp < ?')
    .run(cutoffTime);

  return result.changes;
}
