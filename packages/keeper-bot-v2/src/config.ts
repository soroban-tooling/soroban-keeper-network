export interface EnvRule<T> {
  readonly parse: (raw: string) => T;
  readonly validate: (value: T) => boolean;
  readonly reason: string;
  readonly fallback?: T;
  readonly secret?: boolean;
}

export interface ProfitabilityConfig {
  readonly minimumProfitStroops: bigint;
  readonly executeFeeFallbackStroops: bigint;
  readonly withdrawalFeeStroops: bigint;
  readonly withdrawalBatchSize: bigint;
  readonly riskBufferStroops: bigint;
  readonly maximumEstimateAgeMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function requireEnv<T>(
  name: string,
  rule: EnvRule<T>,
  env: Environment = process.env,
): T {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (Object.hasOwn(rule, "fallback")) {
      return rule.fallback as T;
    }
    throw new Error(`Invalid ${name}: must be set`);
  }

  try {
    const parsed = rule.parse(raw);
    if (!rule.validate(parsed)) {
      throw new Error(rule.reason);
    }
    return parsed;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : rule.reason;
    const supplied = rule.secret ? "" : `: ${raw}`;
    throw new Error(`Invalid ${name}${supplied} - ${detail}`);
  }
}

const nonNegativeBigInt = (value: bigint): boolean => value >= 0n;

export function loadProfitabilityConfig(
  env: Environment = process.env,
): ProfitabilityConfig {
  return {
    minimumProfitStroops: requireEnv(
      "KEEPER_MIN_PROFIT_STROOPS",
      {
        parse: BigInt,
        validate: nonNegativeBigInt,
        reason: "must be a non-negative integer",
        fallback: 0n,
      },
      env,
    ),
    executeFeeFallbackStroops: requireEnv(
      "KEEPER_EXECUTE_FEE_FALLBACK_STROOPS",
      {
        parse: BigInt,
        validate: nonNegativeBigInt,
        reason: "must be a non-negative integer",
        fallback: 1_000_000n,
      },
      env,
    ),
    withdrawalFeeStroops: requireEnv(
      "KEEPER_WITHDRAWAL_FEE_STROOPS",
      {
        parse: BigInt,
        validate: nonNegativeBigInt,
        reason: "must be a non-negative integer",
        fallback: 100_000n,
      },
      env,
    ),
    withdrawalBatchSize: requireEnv(
      "KEEPER_WITHDRAWAL_BATCH_SIZE",
      {
        parse: BigInt,
        validate: (value) => value > 0n,
        reason: "must be a positive integer",
        fallback: 10n,
      },
      env,
    ),
    riskBufferStroops: requireEnv(
      "KEEPER_PROFIT_RISK_BUFFER_STROOPS",
      {
        parse: BigInt,
        validate: nonNegativeBigInt,
        reason: "must be a non-negative integer",
        fallback: 100_000n,
      },
      env,
    ),
    maximumEstimateAgeMs: requireEnv(
      "KEEPER_MAX_ESTIMATE_AGE_MS",
      {
        parse: Number,
        validate: (value) => Number.isSafeInteger(value) && value > 0,
        reason: "must be a positive safe integer",
        fallback: 30_000,
      },
      env,
    ),
  };
}
