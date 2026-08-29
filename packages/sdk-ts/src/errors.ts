// packages/sdk-ts/src/errors.ts

export enum KeeperErrorCode {
  AlreadyInitialized = 1,
  Unauthorized = 2,
  ContractPaused = 3,
  TaskNotFound = 4,
  InvalidTaskStatus = 5,
  DeadlinePassed = 6,
  DeadlineNotPassed = 7,
  InvalidReward = 8,
  LockPeriodActive = 9,
  InvalidFeeBps = 10,
  NotTaskOwner = 11,
  NotTaskClaimer = 12,
  NoRewardsAvailable = 13,
  ProofTooLarge = 14,
  NotInitialized = 15,
  TtlTooShort = 16,
  CalldataTooLarge = 17,
  InvalidTaskParams = 18,
  ArithmeticOverflow = 19,
  IncompatibleVerifierInterface = 20,
  BatchTooLarge = 21,
  EmptyBatch = 22,
  BatchRewardCeilingExceeded = 23,
}

const KEEPER_ERROR_CODES = new Set<number>(
  Object.values(KeeperErrorCode).filter(
    (value): value is number => typeof value === "number",
  ),
);

export function decodeKeeperError(
  result: unknown,
): KeeperErrorCode | undefined {
  const code = extractKeeperErrorCode(result);

  if (code === undefined) {
    return undefined;
  }

  return KEEPER_ERROR_CODES.has(code)
    ? (code as KeeperErrorCode)
    : undefined;
}

function extractKeeperErrorCode(
  result: unknown,
): number | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const candidate = result as Record<string, unknown>;

  const directCandidates = [
    candidate.errorCode,
    candidate.code,
    candidate.contractError,
  ];

  for (const value of directCandidates) {
    const code = toInteger(value);

    if (code !== undefined) {
      return code;
    }
  }

  const nestedCandidates = [
    candidate.error,
    candidate.result,
    candidate.simulation,
    candidate.resultXdr,
    candidate.errorResult,
  ];

  for (const value of nestedCandidates) {
    const code = extractKeeperErrorCode(value);

    if (code !== undefined) {
      return code;
    }
  }

  return undefined;
}

function toInteger(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value)
  ) {
    return value;
  }

  if (
    typeof value === "string" &&
    /^-?\d+$/.test(value)
  ) {
    return Number(value);
  }

  return undefined;
}
