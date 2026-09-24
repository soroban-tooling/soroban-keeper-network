/**
 * Configuration loading and validation for keeper-bot-v2.
 * Follows the same pattern as examples/keeper-bot/index.js
 */

import { config } from "dotenv";
import type { Config } from "./types.js";

config();

function fail(name: string, value: string | null, reason: string): never {
  let message = `Invalid ${name}`;
  if (value) {
    message += `: ${value}`;
  }
  console.error(`${message} — ${reason}`);
  process.exit(1);
}

function requireEnv(
  name: string,
  options: {
    parse?: (value: string) => unknown;
    validate?: { fn: (value: unknown) => boolean; reason: string };
    secret?: boolean;
    fallback?: unknown;
  }
): unknown {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    fail(name, raw ?? null, "must be set");
  }

  try {
    const parsed = options.parse ? options.parse(raw) : raw;
    if (options.validate && !options.validate.fn(parsed)) {
      fail(name, options.secret ? null : raw, options.validate.reason);
    }
    return parsed;
  } catch (e) {
    fail(name, options.secret ? null : raw, (e as Error).message);
  }
}

export async function loadConfig(): Promise<Config> {
  const network = requireEnv("NETWORK", {
    fallback: "testnet",
    validate: {
      fn: (v): v is string => typeof v === "string" && ["testnet", "mainnet"].includes(v),
      reason: 'must be "testnet" or "mainnet"',
    },
  }) as string;

  const registryContractId = requireEnv("REGISTRY_CONTRACT_ID", {
    validate: {
      fn: (v): v is string => typeof v === "string" && v.startsWith("C"),
      reason: "must be a valid contract ID (starts with C...)",
    },
  }) as string;

  const keeperSecretKey = requireEnv("KEEPER_SECRET_KEY", {
    secret: true,
    validate: {
      fn: (v): v is string => typeof v === "string" && v.startsWith("S"),
      reason: "must be a valid secret key (starts with S...)",
    },
  }) as string;

  return {
    network,
    registryContractId,
    keeperSecretKey,
    maxRetries: requireEnv("MAX_RETRIES", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v): v is number => typeof v === "number" && v >= 0, reason: "must be >= 0" },
      fallback: 3,
    }) as number,
    retryBaseMs: requireEnv("RETRY_BASE_MS", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v): v is number => typeof v === "number" && v > 0, reason: "must be > 0" },
      fallback: 500,
    }) as number,
    pollIntervalMs: requireEnv("POLL_INTERVAL_MS", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v): v is number => typeof v === "number" && v >= 1000, reason: "must be >= 1000" },
      fallback: 10000,
    }) as number,
    consecutiveExhaustedRetriesForDegradedMode: requireEnv(
      "CONSECUTIVE_EXHAUSTED_RETRIES_FOR_DEGRADED_MODE",
      {
        parse: (v) => parseInt(v, 10),
        validate: {
          fn: (v): v is number => typeof v === "number" && v >= 1 && v <= 10,
          reason: "must be >= 1 and <= 10",
        },
        fallback: 3,
      }
    ) as number,
    degradedModePollingIntervalMs: requireEnv("DEGRADED_MODE_POLLING_INTERVAL_MS", {
      parse: (v) => parseInt(v, 10),
      validate: {
        fn: (v): v is number => typeof v === "number" && v >= 5000,
        reason: "must be >= 5000",
      },
      fallback: 60000,
    }) as number,
    maxTasksPerRound: requireEnv("MAX_TASKS_PER_ROUND", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v): v is number => typeof v === "number" && v >= 1, reason: "must be >= 1" },
      fallback: 5,
    }) as number,
    withdrawThreshold: requireEnv("WITHDRAW_THRESHOLD", {
      parse: BigInt,
      validate: { fn: (v): v is bigint => typeof v === "bigint" && v >= 0n, reason: "must be >= 0" },
      fallback: 10000000n,
    }) as bigint,
    minProfitMarginStroops: requireEnv("MIN_PROFIT_MARGIN_STROOPS", {
      parse: BigInt,
      validate: { fn: (v): v is bigint => typeof v === "bigint" && v >= 0n, reason: "must be >= 0" },
      fallback: 0n,
    }) as bigint,
    expireStaleTasks: requireEnv("EXPIRE_STALE_TASKS", {
      parse: (v) => v.toLowerCase() === "true",
      fallback: true,
    }) as boolean,
  };
}
