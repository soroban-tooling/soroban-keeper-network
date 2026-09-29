/**
 * Tests for persistent state schema and queries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { initializeSchema, SkipReason } from './schema.js';
import {
  recordTaskOutcome,
  getTaskOutcome,
  hasTaskOutcome,
  recordSkipDecision,
  getRecentSkipDecisions,
  getSkipDecisionsForTask,
  getSkipReasonStats,
} from './schema.js';

describe('Persistent State Schema', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(__dirname, `test-keeper-${Date.now()}.db`);
    db = initializeSchema(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('Task Outcomes', () => {
    it('records a task claim', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed', 'success');

      const outcome = getTaskOutcome(db, taskId);
      expect(outcome).toBeDefined();
      expect(outcome?.taskId).toBe(taskId);
      expect(outcome?.action).toBe('claimed');
      expect(outcome?.keeperAddress).toBe(keeper);
      expect(outcome?.outcome).toBe('success');
    });

    it('records a task execution', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'executed', 'proof: abc123...');

      const outcome = getTaskOutcome(db, taskId);
      expect(outcome?.action).toBe('executed');
      expect(outcome?.outcome).toBe('proof: abc123...');
    });

    it('transitions from claimed to executed', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed', 'initial');
      recordTaskOutcome(db, taskId, keeper, 'executed', 'proof: xyz789...');

      const outcome = getTaskOutcome(db, taskId);
      expect(outcome?.action).toBe('executed');
      expect(outcome?.outcome).toBe('proof: xyz789...');
    });

    it('detects existing task outcomes', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      expect(hasTaskOutcome(db, taskId)).toBe(false);

      recordTaskOutcome(db, taskId, keeper, 'claimed');

      expect(hasTaskOutcome(db, taskId)).toBe(true);
    });

    it('handles missing task outcomes gracefully', () => {
      const outcome = getTaskOutcome(db, 999);
      expect(outcome).toBeUndefined();
    });

    it('stores and retrieves timestamps correctly', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      const beforeRecordTime = Math.floor(Date.now() / 1000);
      recordTaskOutcome(db, taskId, keeper, 'claimed');
      const afterRecordTime = Math.floor(Date.now() / 1000);

      const outcome = getTaskOutcome(db, taskId);
      expect(outcome?.actionTimestamp).toBeGreaterThanOrEqual(beforeRecordTime);
      expect(outcome?.actionTimestamp).toBeLessThanOrEqual(afterRecordTime);
    });
  });

  describe('Skip Decisions', () => {
    it('records a skip decision', () => {
      const taskId = 42;

      recordSkipDecision(db, taskId, SkipReason.DEADLINE_PASSED);

      const decisions = getRecentSkipDecisions(db, 10);
      expect(decisions.length).toBe(1);
      expect(decisions[0].taskId).toBe(taskId);
      expect(decisions[0].reason).toBe(SkipReason.DEADLINE_PASSED);
    });

    it('records skip decision with task info', () => {
      const taskId = 42;
      const taskInfo = { reward: 1000, deadline: 1234567890 };

      recordSkipDecision(db, taskId, SkipReason.UNPROFITABLE, taskInfo);

      const decisions = getRecentSkipDecisions(db, 10);
      expect(decisions[0].taskInfo).toEqual(taskInfo);
    });

    it('retrieves decisions in reverse chronological order', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.UNPROFITABLE);
      recordSkipDecision(db, 3, SkipReason.NO_EXECUTOR);

      const decisions = getRecentSkipDecisions(db, 10);

      // Most recent first
      expect(decisions[0].taskId).toBe(3);
      expect(decisions[1].taskId).toBe(2);
      expect(decisions[2].taskId).toBe(1);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        recordSkipDecision(db, i, SkipReason.DEADLINE_PASSED);
      }

      const decisions = getRecentSkipDecisions(db, 5);
      expect(decisions.length).toBe(5);
    });

    it('retrieves skip decisions for a specific task', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.UNPROFITABLE);
      recordSkipDecision(db, 1, SkipReason.NO_EXECUTOR);

      const taskDecisions = getSkipDecisionsForTask(db, 1);

      expect(taskDecisions.length).toBe(2);
      expect(taskDecisions[0].taskId).toBe(1);
      expect(taskDecisions[1].taskId).toBe(1);
    });

    it('returns empty array for task with no skip decisions', () => {
      const decisions = getSkipDecisionsForTask(db, 999);
      expect(decisions.length).toBe(0);
    });
  });

  describe('Skip Reason Statistics', () => {
    it('counts skip reasons correctly', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 3, SkipReason.UNPROFITABLE);
      recordSkipDecision(db, 4, SkipReason.NO_EXECUTOR);
      recordSkipDecision(db, 5, SkipReason.UNPROFITABLE);
      recordSkipDecision(db, 6, SkipReason.UNPROFITABLE);

      const stats = getSkipReasonStats(db, 100);

      expect(stats[SkipReason.DEADLINE_PASSED]).toBe(2);
      expect(stats[SkipReason.UNPROFITABLE]).toBe(3);
      expect(stats[SkipReason.NO_EXECUTOR]).toBe(1);
    });

    it('respects the limit when computing statistics', () => {
      for (let i = 0; i < 20; i++) {
        recordSkipDecision(db, i, i % 2 === 0 ? SkipReason.DEADLINE_PASSED : SkipReason.UNPROFITABLE);
      }

      // Only analyze the 5 most recent
      const stats = getSkipReasonStats(db, 5);

      // With 5 most recent, we'll have 2-3 of each
      const total = (stats[SkipReason.DEADLINE_PASSED] || 0) + (stats[SkipReason.UNPROFITABLE] || 0);
      expect(total).toBe(5);
    });
  });

  describe('Edge Cases', () => {
    it('handles very large task IDs', () => {
      const largeTaskId = Number.MAX_SAFE_INTEGER - 1;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, largeTaskId, keeper, 'claimed');

      const outcome = getTaskOutcome(db, largeTaskId);
      expect(outcome?.taskId).toBe(largeTaskId);
    });

    it('handles empty outcome string', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed', '');

      const outcome = getTaskOutcome(db, taskId);
      expect(outcome?.outcome).toBe('');
    });

    it('handles null task info in skip decisions', () => {
      recordSkipDecision(db, 42, SkipReason.DEADLINE_PASSED, null);

      const decisions = getRecentSkipDecisions(db, 10);
      expect(decisions[0].taskInfo).toBeNull();
    });

    it('handles undefined task info in skip decisions', () => {
      recordSkipDecision(db, 42, SkipReason.DEADLINE_PASSED, undefined);

      const decisions = getRecentSkipDecisions(db, 10);
      expect(decisions[0].taskInfo).toBeUndefined();
    });

    it('handles complex nested task info', () => {
      const taskInfo = {
        reward: 1000,
        deadline: 1234567890,
        nested: {
          deep: {
            data: [1, 2, 3],
          },
        },
      };

      recordSkipDecision(db, 42, SkipReason.UNPROFITABLE, taskInfo);

      const decisions = getRecentSkipDecisions(db, 10);
      expect(decisions[0].taskInfo).toEqual(taskInfo);
    });
  });

  describe('Persistence Across Connections', () => {
    it('persists task outcomes across database closes', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed');
      db.close();

      const db2 = initializeSchema(dbPath);
      const outcome = getTaskOutcome(db2, taskId);

      expect(outcome?.taskId).toBe(taskId);
      expect(outcome?.action).toBe('claimed');
      db2.close();
    });

    it('persists skip decisions across database closes', () => {
      recordSkipDecision(db, 42, SkipReason.DEADLINE_PASSED);
      db.close();

      const db2 = initializeSchema(dbPath);
      const decisions = getRecentSkipDecisions(db2, 10);

      expect(decisions.length).toBe(1);
      expect(decisions[0].taskId).toBe(42);
      db2.close();
    });
  });
});
