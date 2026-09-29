/**
 * Tests for runtime inspection commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { initializeSchema, recordTaskOutcome, recordSkipDecision, SkipReason } from './state/schema.js';
import {
  inspectTask,
  inspectConfig,
  inspectSkipDecisions,
  inspectTaskSkipDecisions,
  verifyNoSecretsInOutput,
} from './inspect.js';
import type { BotConfig } from './config.js';

describe('Runtime Inspection Commands', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(__dirname, `test-inspect-${Date.now()}.db`);
    db = initializeSchema(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe('inspectTask', () => {
    it('returns unknown status for task with no outcome', () => {
      const result = inspectTask(db, 999);

      expect(result.taskId).toBe(999);
      expect(result.status).toBe('unknown');
      expect(result.keeperAddress).toBeUndefined();
    });

    it('returns claimed status for claimed task', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed', 'success');

      const result = inspectTask(db, taskId);

      expect(result.taskId).toBe(taskId);
      expect(result.status).toBe('claimed');
      expect(result.keeperAddress).toBe(keeper);
      expect(result.outcome).toBe('success');
    });

    it('returns executed status for executed task', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'executed', 'proof: abc123...');

      const result = inspectTask(db, taskId);

      expect(result.status).toBe('executed');
      expect(result.outcome).toBe('proof: abc123...');
    });

    it('includes ISO timestamp in output', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed');

      const result = inspectTask(db, taskId);

      expect(result.actionTimestampIso).toBeDefined();
      expect(result.actionTimestampIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('output contains no secrets', () => {
      const taskId = 42;
      const keeper = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      recordTaskOutcome(db, taskId, keeper, 'claimed');

      const result = inspectTask(db, taskId);

      expect(verifyNoSecretsInOutput(result)).toBe(true);
    });
  });

  describe('inspectConfig', () => {
    it('includes network and registry contract', () => {
      const config: BotConfig = {
        network: 'testnet',
        registryContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        secretKey: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        once: false,
        pollIntervalMs: 10000,
        withdrawThreshold: 10000000n,
        maxTasksPerRound: 5,
        maxRetries: 3,
        retryBaseMs: 500,
        expireStaleTasks: true,
        minProfitMarginStroops: 0n,
        stateDbPath: './keeper-state.db',
        simulateExecution: false,
      };

      const result = inspectConfig(config, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

      expect(result.network).toBe('testnet');
      expect(result.registryContractId).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4');
      expect(result.keeperAddress).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    });

    it('redacts secret key', () => {
      const config: BotConfig = {
        network: 'testnet',
        registryContractId: 'C123...',
        secretKey: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        once: false,
        pollIntervalMs: 10000,
        withdrawThreshold: 10000000n,
        maxTasksPerRound: 5,
        maxRetries: 3,
        retryBaseMs: 500,
        expireStaleTasks: true,
        minProfitMarginStroops: 0n,
        stateDbPath: './keeper-state.db',
        simulateExecution: false,
      };

      const result = inspectConfig(config, 'G123...');

      expect(result.secretKey).toBe('***REDACTED***');
    });

    it('includes numeric config values', () => {
      const config: BotConfig = {
        network: 'testnet',
        registryContractId: 'C123...',
        secretKey: 'S...',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        once: false,
        pollIntervalMs: 15000,
        withdrawThreshold: 5000000n,
        maxTasksPerRound: 10,
        maxRetries: 5,
        retryBaseMs: 1000,
        expireStaleTasks: false,
        minProfitMarginStroops: 100n,
        stateDbPath: './keeper-state.db',
        simulateExecution: false,
      };

      const result = inspectConfig(config, 'G123...');

      expect(result.pollIntervalMs).toBe(15000);
      expect(result.maxTasksPerRound).toBe(10);
      expect(result.maxRetries).toBe(5);
      expect(result.minProfitMarginStroops).toBe('100');
    });

    it('output contains no secrets', () => {
      const config: BotConfig = {
        network: 'testnet',
        registryContractId: 'C123...',
        secretKey: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        once: false,
        pollIntervalMs: 10000,
        withdrawThreshold: 10000000n,
        maxTasksPerRound: 5,
        maxRetries: 3,
        retryBaseMs: 500,
        expireStaleTasks: true,
        minProfitMarginStroops: 0n,
        stateDbPath: './keeper-state.db',
        simulateExecution: false,
      };

      const result = inspectConfig(config, 'G123...');

      expect(verifyNoSecretsInOutput(result)).toBe(true);
    });
  });

  describe('inspectSkipDecisions', () => {
    it('returns empty array when no skip decisions recorded', () => {
      const result = inspectSkipDecisions(db);

      expect(result.decisions.length).toBe(0);
      expect(result.count).toBe(0);
    });

    it('returns recorded skip decisions', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.UNPROFITABLE, { reward: 100, estimated_gas: 200 });

      const result = inspectSkipDecisions(db);

      expect(result.count).toBe(2);
      expect(result.decisions[0].taskId).toBe(2); // Most recent first
      expect(result.decisions[1].taskId).toBe(1);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        recordSkipDecision(db, i, SkipReason.DEADLINE_PASSED);
      }

      const result = inspectSkipDecisions(db, 5);

      expect(result.decisions.length).toBe(5);
    });

    it('includes ISO timestamps', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);

      const result = inspectSkipDecisions(db);

      expect(result.decisions[0].timestampIso).toBeDefined();
      expect(result.decisions[0].timestampIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('includes formatted details', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.UNPROFITABLE, { estimated_gas: 200, reward: 100 });

      const result = inspectSkipDecisions(db, 10);

      expect(result.decisions[1].details).toContain('deadline_passed');
      expect(result.decisions[0].details).toContain('unprofitable');
      expect(result.decisions[0].details).toContain('gas');
    });

    it('optionally includes statistics', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 3, SkipReason.UNPROFITABLE);

      const resultWithoutStats = inspectSkipDecisions(db, 100, false);
      expect(resultWithoutStats.stats).toBeUndefined();

      const resultWithStats = inspectSkipDecisions(db, 100, true);
      expect(resultWithStats.stats).toBeDefined();
      expect(resultWithStats.stats?.[SkipReason.DEADLINE_PASSED]).toBe(2);
    });

    it('output contains no secrets', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED, { token: 'secret123' });

      const result = inspectSkipDecisions(db);

      expect(verifyNoSecretsInOutput(result)).toBe(true);
    });
  });

  describe('inspectTaskSkipDecisions', () => {
    it('returns empty array for task with no skip decisions', () => {
      const result = inspectTaskSkipDecisions(db, 999);

      expect(result.decisions.length).toBe(0);
      expect(result.count).toBe(0);
    });

    it('returns skip decisions for a specific task', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 2, SkipReason.UNPROFITABLE);
      recordSkipDecision(db, 1, SkipReason.NO_EXECUTOR);

      const result = inspectTaskSkipDecisions(db, 1);

      expect(result.count).toBe(2);
      expect(result.decisions[0].taskId).toBe(1);
      expect(result.decisions[1].taskId).toBe(1);
    });

    it('returns most recent skip decisions first', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);
      recordSkipDecision(db, 1, SkipReason.UNPROFITABLE);

      const result = inspectTaskSkipDecisions(db, 1);

      expect(result.decisions[0].reason).toBe(SkipReason.UNPROFITABLE);
      expect(result.decisions[1].reason).toBe(SkipReason.DEADLINE_PASSED);
    });

    it('output contains no secrets', () => {
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED, { apiKey: 'secret' });

      const result = inspectTaskSkipDecisions(db, 1);

      expect(verifyNoSecretsInOutput(result)).toBe(true);
    });
  });

  describe('Security and Hygiene', () => {
    it('verifyNoSecretsInOutput detects Stellar secret keys', () => {
      const output = {
        data: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      };

      expect(verifyNoSecretsInOutput(output)).toBe(false);
    });

    it('verifyNoSecretsInOutput allows redacted values', () => {
      const output = {
        secretKey: '***REDACTED***',
        other: 'data',
      };

      expect(verifyNoSecretsInOutput(output)).toBe(true);
    });

    it('all inspection outputs are verified secret-free', () => {
      recordTaskOutcome(db, 1, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'claimed');
      recordSkipDecision(db, 1, SkipReason.DEADLINE_PASSED);

      const taskResult = inspectTask(db, 1);
      expect(verifyNoSecretsInOutput(taskResult)).toBe(true);

      const configResult = inspectConfig(
        {
          network: 'testnet',
          registryContractId: 'C123...',
          secretKey: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          rpcUrl: 'https://example.com',
          networkPassphrase: 'test',
          once: false,
          pollIntervalMs: 10000,
          withdrawThreshold: 10000000n,
          maxTasksPerRound: 5,
          maxRetries: 3,
          retryBaseMs: 500,
          expireStaleTasks: true,
          minProfitMarginStroops: 0n,
          stateDbPath: './test.db',
          simulateExecution: false,
        },
        'G123...',
      );
      expect(verifyNoSecretsInOutput(configResult)).toBe(true);

      const skipsResult = inspectSkipDecisions(db);
      expect(verifyNoSecretsInOutput(skipsResult)).toBe(true);
    });
  });
});
