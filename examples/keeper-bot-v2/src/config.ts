import { StrKey } from "@stellar/stellar-sdk";

export class ConfigValidationError extends Error {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ConfigValidationError";
    this.field = field;
    Object.setPrototypeOf(this, ConfigValidationError.prototype);
  }
}

export type NetworkName = "testnet" | "futurenet" | "mainnet";
export type SecretBackend = "env" | "vault" | "aws_secrets_manager";

export interface KeeperBotV2Config {
  network: NetworkName;
  registryContractId: string;
  signingKeys: string[];
  databaseUrl?: string;
  persistenceEnabled: boolean;
  maxConcurrentTasks: number;
  maxTasksPerRound: number;
  pollIntervalMs: number;
  minProfitMarginStroops: bigint;
  feeCeilingStroops: bigint;
  withdrawThreshold: bigint;
  maxRetries: number;
  retryBaseMs: number;
  expireStaleTasks: boolean;
  simulateExecution: boolean;
  secretBackend: SecretBackend;
  vaultAddr?: string;
  awsSecretName?: string;
  metricsEnabled: boolean;
  metricsPort: number;
  runOnce: boolean;
}

const VALID_NETWORKS: readonly NetworkName[] = ["testnet", "futurenet", "mainnet"];
const VALID_SECRET_BACKENDS: readonly SecretBackend[] = ["env", "vault", "aws_secrets_manager"];

function failField(name: string, value: unknown, reason: string, secret = false): never {
  const displayVal = secret ? "[REDACTED]" : value !== undefined ? `: ${String(value)}` : "";
  throw new ConfigValidationError(`Invalid ${name}${displayVal} — ${reason}`, name);
}

function requireEnvValue<T>(
  env: Record<string, string | undefined>,
  name: string,
  options: {
    parse?: (v: string) => T;
    validate?: { fn: (v: T) => boolean; reason: string };
    secret?: boolean;
    fallback?: T;
  } = {}
): T {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    failField(name, undefined, "must be set", options.secret);
  }

  try {
    const parsed = options.parse ? options.parse(raw) : (raw as unknown as T);
    if (options.validate && !options.validate.fn(parsed)) {
      failField(name, raw, options.validate.reason, options.secret);
    }
    return parsed;
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    failField(name, raw, message, options.secret);
  }
}

/**
 * Validates the full configuration dictionary at startup.
 * Applies per-field strict checks followed by cross-field consistency checks.
 */
export function validateConfig(rawEnv: Record<string, string | undefined> = process.env): KeeperBotV2Config {
  // 1. Per-field validation
  const network = requireEnvValue<NetworkName>(rawEnv, "NETWORK", {
    validate: {
      fn: (v): boolean => VALID_NETWORKS.includes(v as NetworkName),
      reason: `must be one of: ${VALID_NETWORKS.join(", ")}`,
    },
    fallback: "testnet",
  });

  const registryContractId = requireEnvValue<string>(rawEnv, "REGISTRY_CONTRACT_ID", {
    validate: {
      fn: (v): boolean => typeof v === "string" && StrKey.isValidContract(v),
      reason: "must be a valid contract ID (starts with C... and 56 characters)",
    },
  });

  const secretBackend = requireEnvValue<SecretBackend>(rawEnv, "SECRET_BACKEND", {
    validate: {
      fn: (v): boolean => VALID_SECRET_BACKENDS.includes(v as SecretBackend),
      reason: `must be one of: ${VALID_SECRET_BACKENDS.join(", ")}`,
    },
    fallback: "env",
  });

  const vaultAddr = rawEnv.VAULT_ADDR?.trim();
  const awsSecretName = rawEnv.AWS_SECRET_NAME?.trim();

  // Signing keys validation (support single KEEPER_SECRET_KEY or multi-account SIGNING_KEY_POOL)
  const signingPoolRaw = rawEnv.SIGNING_KEY_POOL?.trim();
  const singleKeyRaw = rawEnv.KEEPER_SECRET_KEY?.trim();

  let signingKeys: string[] = [];
  if (signingPoolRaw) {
    signingKeys = signingPoolRaw.split(",").map((k) => k.trim()).filter(Boolean);
  } else if (singleKeyRaw) {
    signingKeys = [singleKeyRaw];
  } else if (secretBackend === "env") {
    failField("KEEPER_SECRET_KEY", undefined, "must be set when SECRET_BACKEND is 'env'", true);
  }

  for (let i = 0; i < signingKeys.length; i++) {
    const key = signingKeys[i];
    if (!StrKey.isValidEd25519SecretSeed(key)) {
      failField(
        signingPoolRaw ? `SIGNING_KEY_POOL[${i}]` : "KEEPER_SECRET_KEY",
        null,
        "must be a valid secret seed (starts with S...)",
        true
      );
    }
  }

  const maxConcurrentTasks = requireEnvValue<number>(rawEnv, "MAX_CONCURRENT_TASKS", {
    parse: (v) => {
      const parsed = parseInt(v, 10);
      if (isNaN(parsed)) throw new Error("must be an integer");
      return parsed;
    },
    validate: { fn: (v) => v >= 1, reason: "must be >= 1" },
    fallback: 1,
  });

  const maxTasksPerRound = requireEnvValue<number>(rawEnv, "MAX_TASKS_PER_ROUND", {
    parse: (v) => {
      const parsed = parseInt(v, 10);
      if (isNaN(parsed)) throw new Error("must be an integer");
      return parsed;
    },
    validate: { fn: (v) => v >= 1, reason: "must be >= 1" },
    fallback: 5,
  });

  const pollIntervalMs = requireEnvValue<number>(rawEnv, "POLL_INTERVAL_MS", {
    parse: (v) => {
      const parsed = parseInt(v, 10);
      if (isNaN(parsed)) throw new Error("must be an integer");
      return parsed;
    },
    validate: { fn: (v) => v >= 1000, reason: "must be >= 1000" },
    fallback: 10000,
  });

  const minProfitMarginStroops = requireEnvValue<bigint>(rawEnv, "MIN_PROFIT_MARGIN_STROOPS", {
    parse: (v) => BigInt(v),
    validate: { fn: (v) => v >= 0n, reason: "must be >= 0" },
    fallback: 0n,
  });

  const feeCeilingStroops = requireEnvValue<bigint>(rawEnv, "FEE_CEILING_STROOPS", {
    parse: (v) => BigInt(v),
    validate: { fn: (v) => v >= 0n, reason: "must be >= 0" },
    fallback: 1000000n,
  });

  const withdrawThreshold = requireEnvValue<bigint>(rawEnv, "WITHDRAW_THRESHOLD", {
    parse: (v) => BigInt(v),
    validate: { fn: (v) => v >= 0n, reason: "must be >= 0" },
    fallback: 10000000n,
  });

  const maxRetries = requireEnvValue<number>(rawEnv, "MAX_RETRIES", {
    parse: (v) => {
      const parsed = parseInt(v, 10);
      if (isNaN(parsed)) throw new Error("must be an integer");
      return parsed;
    },
    validate: { fn: (v) => v >= 0, reason: "must be >= 0" },
    fallback: 3,
  });

  const retryBaseMs = requireEnvValue<number>(rawEnv, "RETRY_BASE_MS", {
    parse: (v) => {
      const parsed = parseInt(v, 10);
      if (isNaN(parsed)) throw new Error("must be an integer");
      return parsed;
    },
    validate: { fn: (v) => v > 0, reason: "must be > 0" },
    fallback: 500,
  });

  const expireStaleTasks = requireEnvValue<boolean>(rawEnv, "EXPIRE_STALE_TASKS", {
    parse: (v) => v.toLowerCase() === "true",
    fallback: true,
  });

  const simulateExecution = requireEnvValue<boolean>(rawEnv, "SIMULATE_EXECUTION", {
    parse: (v) => v.toLowerCase() === "true",
    fallback: false,
  });

  const databaseUrl = rawEnv.DATABASE_URL?.trim();
  const persistenceEnabled = Boolean(databaseUrl);

  const metricsEnabled = requireEnvValue<boolean>(rawEnv, "METRICS_ENABLED", {
    parse: (v) => v.toLowerCase() === "true",
    fallback: true,
  });

  const metricsPort = requireEnvValue<number>(rawEnv, "METRICS_PORT", {
    parse: (v) => {
      const parsed = parseInt(v, 10);
      if (isNaN(parsed)) throw new Error("must be an integer");
      return parsed;
    },
    validate: { fn: (v) => v >= 1 && v <= 65535, reason: "must be between 1 and 65535" },
    fallback: 9090,
  });

  const runOnce = rawEnv.RUN_ONCE === "true" || process.argv.includes("--once");

  // 2. Cross-field consistency checks (catching multi-field interactions at startup)

  // Inconsistency 1: Concurrency limit vs Account pool size
  if (secretBackend === "env" && maxConcurrentTasks > signingKeys.length) {
    throw new ConfigValidationError(
      `Cross-field validation failed: MAX_CONCURRENT_TASKS (${maxConcurrentTasks}) cannot exceed the number of signing accounts in the pool (${signingKeys.length}). Concurrent task execution requires dedicated signing accounts to prevent transaction sequence number collisions.`,
      "MAX_CONCURRENT_TASKS"
    );
  }

  // Inconsistency 2: Profitability margin vs Fee ceiling
  if (feeCeilingStroops > 0n && minProfitMarginStroops > feeCeilingStroops) {
    throw new ConfigValidationError(
      `Cross-field validation failed: MIN_PROFIT_MARGIN_STROOPS (${minProfitMarginStroops}) exceeds FEE_CEILING_STROOPS (${feeCeilingStroops}). At this fee ceiling, no task can ever be profitable.`,
      "MIN_PROFIT_MARGIN_STROOPS"
    );
  }

  // Inconsistency 3: Concurrency limit vs Max tasks per round
  if (maxConcurrentTasks > maxTasksPerRound) {
    throw new ConfigValidationError(
      `Cross-field validation failed: MAX_CONCURRENT_TASKS (${maxConcurrentTasks}) cannot exceed MAX_TASKS_PER_ROUND (${maxTasksPerRound}).`,
      "MAX_CONCURRENT_TASKS"
    );
  }

  // Inconsistency 4: Secret backend requirements
  if (secretBackend === "vault" && !vaultAddr) {
    throw new ConfigValidationError(
      `Cross-field validation failed: SECRET_BACKEND is set to "vault", but VAULT_ADDR is missing or empty.`,
      "VAULT_ADDR"
    );
  }
  if (secretBackend === "aws_secrets_manager" && !awsSecretName) {
    throw new ConfigValidationError(
      `Cross-field validation failed: SECRET_BACKEND is set to "aws_secrets_manager", but AWS_SECRET_NAME is missing or empty.`,
      "AWS_SECRET_NAME"
    );
  }

  // Inconsistency 5: Retry backoff vs Poll interval
  const maxBackoff = retryBaseMs * Math.pow(2, maxRetries);
  if (maxBackoff > pollIntervalMs * 10) {
    throw new ConfigValidationError(
      `Cross-field validation failed: Maximum retry backoff duration (${maxBackoff}ms) exceeds 10x poll interval (${pollIntervalMs * 10}ms). Retries will cause overlapping rounds.`,
      "RETRY_BASE_MS"
    );
  }

  return {
    network,
    registryContractId,
    signingKeys,
    databaseUrl,
    persistenceEnabled,
    maxConcurrentTasks,
    maxTasksPerRound,
    pollIntervalMs,
    minProfitMarginStroops,
    feeCeilingStroops,
    withdrawThreshold,
    maxRetries,
    retryBaseMs,
    expireStaleTasks,
    simulateExecution,
    secretBackend,
    vaultAddr,
    awsSecretName,
    metricsEnabled,
    metricsPort,
    runOnce,
  };
}

export function validateAndLoadConfig(): KeeperBotV2Config {
  try {
    return validateConfig(process.env);
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) {
      console.error(`[CONFIG ERROR] ${err.message}`);
    } else {
      console.error(`[CONFIG ERROR] Unexpected error:`, err);
    }
    process.exit(1);
  }
}
