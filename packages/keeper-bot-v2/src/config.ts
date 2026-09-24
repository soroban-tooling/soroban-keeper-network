/**
 * Configuration Loading and Validation
 *
 * Extends the secret-hygiene patterns from v1's requireEnv (examples/keeper-bot/index.js)
 * with TypeScript type safety and structured validation.
 */

import 'dotenv/config';
import { StrKey } from '@stellar/stellar-sdk';
import { NETWORK_PRESETS, isNetworkName } from '@soroban-keeper-network/sdk';

/**
 * Configuration validation helper, following v1's requireEnv pattern.
 *
 * @param name - Environment variable name
 * @param options - Validation options
 * @returns The parsed and validated value, or throws
 */
function requireEnv(
  name: string,
  options: {
    parse?: (value: string) => unknown;
    validate?: { fn: (value: unknown) => boolean; reason: string };
    secret?: boolean;
    fallback?: unknown;
  } = {},
): unknown {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    const logValue = options.secret ? null : raw;
    throw new Error(`Invalid ${name}${logValue ? `: ${logValue}` : ''} — must be set`);
  }

  try {
    const parsed = options.parse ? options.parse(raw) : raw;
    if (options.validate && !options.validate.fn(parsed)) {
      const logValue = options.secret ? null : raw;
      const msg = `Invalid ${name}${logValue ? `: ${logValue}` : ''} — ${options.validate.reason}`;
      throw new Error(msg);
    }
    return parsed;
  } catch (e) {
    const logValue = options.secret ? null : raw;
    const msg = `Invalid ${name}${logValue ? `: ${logValue}` : ''} — ${e instanceof Error ? e.message : String(e)}`;
    throw new Error(msg);
  }
}

/**
 * Complete runtime configuration for the keeper bot.
 *
 * All values are validated at startup and will not change unless the
 * process is restarted. This immutability is intentional to simplify
 * concurrent processing and inspection.
 */
export interface BotConfig {
  // Network and contract
  network: 'testnet' | 'futurenet' | 'mainnet';
  registryContractId: string;
  secretKey: string; // Never logged or inspected directly; marked for redaction
  rpcUrl: string;
  networkPassphrase: string;

  // Runtime behavior
  once: boolean; // Run once then exit (vs daemon mode)
  pollIntervalMs: number; // Milliseconds between rounds in daemon mode
  withdrawThreshold: bigint; // Minimum balance before withdrawing
  maxTasksPerRound: number; // Maximum tasks to process per round
  maxRetries: number; // Maximum retry attempts for transient errors
  retryBaseMs: number; // Base delay (ms) for exponential backoff
  expireStaleTasks: boolean; // Whether to expire tasks past their deadline
  minProfitMarginStroops: bigint; // Minimum net profit before claiming

  // Persistence
  stateDbPath: string; // Path to SQLite database for persistent state

  // Indexer integration (optional — both must be set to enable indexer mode)
  // When configured, candidate tasks are discovered via the indexer WebSocket
  // feed instead of direct RPC getEvents scanning. The authoritative on-chain
  // is_claimable check is still performed before every claim regardless of
  // which source is active.
  indexerWsUrl: string | null; // WebSocket endpoint, e.g. ws://indexer:8080/v1/ws
  indexerRestUrl: string | null; // REST base URL, e.g. http://indexer:8080/v1

  // Development
  simulateExecution: boolean; // Use simulated execution (dev only, never production)
}

/**
 * Load and validate the complete configuration from environment variables.
 *
 * @returns The validated configuration object
 * @throws If any required configuration is missing or invalid
 */
export function loadConfig(): BotConfig {
  const network = requireEnv('NETWORK', {
    validate: {
      fn: (v): v is string => typeof v === 'string' && isNetworkName(v),
      reason: `must be one of: testnet, futurenet, mainnet`,
    },
    fallback: 'testnet',
  }) as string;

  const registryContractId = requireEnv('REGISTRY_CONTRACT_ID', {
    validate: {
      fn: (v): v is string => typeof v === 'string' && StrKey.isValidContract(v),
      reason: 'must be a valid contract ID (starts with C...)',
    },
  }) as string;

  const secretKey = requireEnv('KEEPER_SECRET_KEY', {
    secret: true,
    validate: {
      fn: (v): v is string =>
        typeof v === 'string' && StrKey.isValidEd25519SecretSeed(v),
      reason: 'must be a valid secret key (starts with S...)',
    },
  }) as string;

  const networkConfig = NETWORK_PRESETS[network];
  const { rpcUrl, networkPassphrase } = networkConfig;

  const config: BotConfig = {
    network: network as 'testnet' | 'futurenet' | 'mainnet',
    registryContractId,
    secretKey,
    rpcUrl,
    networkPassphrase,

    once: process.argv.includes('--once') || process.env.RUN_ONCE === 'true',

    pollIntervalMs: requireEnv('POLL_INTERVAL_MS', {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => typeof v === 'number' && v >= 1000, reason: 'must be >= 1000' },
      fallback: 10000,
    }) as number,

    withdrawThreshold: requireEnv('WITHDRAW_THRESHOLD', {
      parse: BigInt,
      validate: { fn: (v) => typeof v === 'bigint' && v >= 0n, reason: 'must be >= 0' },
      fallback: 10000000n,
    }) as bigint,

    maxTasksPerRound: requireEnv('MAX_TASKS_PER_ROUND', {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => typeof v === 'number' && v >= 1, reason: 'must be >= 1' },
      fallback: 5,
    }) as number,

    maxRetries: requireEnv('MAX_RETRIES', {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => typeof v === 'number' && v >= 0, reason: 'must be >= 0' },
      fallback: 3,
    }) as number,

    retryBaseMs: requireEnv('RETRY_BASE_MS', {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => typeof v === 'number' && v > 0, reason: 'must be > 0' },
      fallback: 500,
    }) as number,

    expireStaleTasks: requireEnv('EXPIRE_STALE_TASKS', {
      parse: (v) => v.toLowerCase() === 'true',
      fallback: true,
    }) as boolean,

    minProfitMarginStroops: requireEnv('MIN_PROFIT_MARGIN_STROOPS', {
      parse: BigInt,
      validate: {
        fn: (v) => typeof v === 'bigint' && v >= 0n,
        reason: 'must be >= 0',
      },
      fallback: 0n,
    }) as bigint,

    stateDbPath: requireEnv('STATE_DB_PATH', {
      fallback: './keeper-state.db',
    }) as string,

    // Indexer endpoints are optional. Both must be set for indexer mode to
    // engage; a partial configuration is treated as "not configured" and falls
    // back to direct RPC scanning so a misconfigured env does not silently
    // disable task discovery.
    indexerWsUrl: requireEnv('INDEXER_WS_URL', {
      validate: {
        fn: (v): v is string =>
          typeof v === 'string' && (v.startsWith('ws://') || v.startsWith('wss://')),
        reason: 'must start with ws:// or wss://',
      },
      fallback: null,
    }) as string | null,

    indexerRestUrl: requireEnv('INDEXER_REST_URL', {
      validate: {
        fn: (v): v is string =>
          typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://')),
        reason: 'must start with http:// or https://',
      },
      fallback: null,
    }) as string | null,

    simulateExecution: requireEnv('SIMULATE_EXECUTION', {
      parse: (v) => v.toLowerCase() === 'true',
      fallback: false,
    }) as boolean,
  };

  return config;
}
