#!/usr/bin/env node

/**
 * CLI Entry Point
 *
 * Provides command-line interface for the keeper bot with subcommands for:
 * - Daemon operation (start)
 * - Runtime inspection (inspect task, config, skip-decisions)
 *
 * This is CLI-driven, following v1's pattern of using process.argv inspection.
 * The bot can be started in daemon mode or single-round mode, and inspection
 * commands query the persisted state database without requiring the bot to restart.
 */

import { program } from 'commander';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from './config.js';
import { getDatabase, closeDatabase } from './state/database.js';
import {
  inspectTask,
  inspectConfig,
  inspectSkipDecisions,
  inspectTaskSkipDecisions,
} from './inspect.js';

/**
 * Main entry point for the CLI.
 */
async function main(): Promise<void> {
  program
    .name('keeper-bot')
    .description('Soroban Keeper Network v2 — Production-grade keeper bot with runtime inspection')
    .version('0.2.0');

  // Start command (daemon or one-shot)
  program
    .command('start', { isDefault: true })
    .description('Start the keeper bot (daemon mode by default)')
    .option('--once', 'Run one round then exit')
    .action(async (options) => {
      console.log('[keeper-bot] Starting...');
      console.log(
        '[keeper-bot] NOTE: Full keeper-bot start implementation is pending (issue #0251).',
      );
      console.log('[keeper-bot] This is the inspection-focused release for issue #393.');

      if (options.once) {
        console.log('[keeper-bot] Mode: single round (--once)');
      } else {
        console.log('[keeper-bot] Mode: daemon');
      }

      process.exit(0);
    });

  // Inspect command group
  const inspect = program
    .command('inspect')
    .description('Inspect a running bot\'s state')
    .action(() => {
      // Show help if no subcommand is provided
      inspect.help();
    });

  // inspect task <task-id>
  inspect
    .command('task <taskId>')
    .description('Query persisted state for a specific task')
    .action(async (taskIdStr: string) => {
      try {
        const taskId = parseInt(taskIdStr, 10);
        if (isNaN(taskId)) {
          console.error('Error: task-id must be a valid number');
          process.exit(1);
        }

        const config = loadConfig();
        const db = getDatabase(config.stateDbPath);

        try {
          const result = inspectTask(db, taskId);
          console.log(JSON.stringify(result, null, 2));
        } finally {
          closeDatabase();
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // inspect config
  inspect
    .command('config')
    .description('Dump current configuration (with secrets redacted)')
    .action(async () => {
      try {
        const config = loadConfig();
        const keypair = Keypair.fromSecret(config.secretKey);

        const result = inspectConfig(config, keypair.publicKey());
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // inspect skip-decisions
  inspect
    .command('skip-decisions')
    .description('Show recent skip decisions and their reasons')
    .option('--limit <n>', 'Maximum number of decisions to return', '100')
    .option('--task-id <id>', 'Show skips for a specific task only')
    .option('--stats', 'Include reason statistics')
    .action(async (options) => {
      try {
        const limit = parseInt(options.limit, 10);
        if (isNaN(limit) || limit < 1) {
          console.error('Error: --limit must be a positive number');
          process.exit(1);
        }

        const config = loadConfig();
        const db = getDatabase(config.stateDbPath);

        try {
          let result;

          if (options.taskId) {
            const taskId = parseInt(options.taskId, 10);
            if (isNaN(taskId)) {
              console.error('Error: --task-id must be a valid number');
              process.exit(1);
            }
            result = inspectTaskSkipDecisions(db, taskId);
          } else {
            result = inspectSkipDecisions(db, limit, options.stats !== undefined);
          }

          console.log(JSON.stringify(result, null, 2));
        } finally {
          closeDatabase();
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // Parse and execute
  await program.parseAsync(process.argv);
}

// Only run main() when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { main };
