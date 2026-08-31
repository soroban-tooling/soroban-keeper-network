// Typed decoding of the contract's error codes. Mirrors
// `contracts/keeper-registry/src/errors.rs::KeeperError` exactly — discriminants
// are part of the published ABI, never renumber an existing variant here
// without renumbering it there too.

/** Mirrors `contracts/keeper-registry/src/errors.rs::KeeperError`. */
// packages/sdk-ts/src/errors.ts
/**
 * Typed decoding of the KeeperRegistry contract's error enum (issue 0166 in
 * the SDK epic).
 *
 * Mirrors `contracts/keeper-registry/src/errors.rs`'s `KeeperError` enum
 * exactly — same names, same discriminants. That file's own doc comment
 * states the discriminants are part of the published ABI and are never
 * renumbered, only appended to, which is what makes decoding by number
 * safe here rather than fragile.
 *
 * `KeeperRegistryClient.invoke()`/`.read()` reject with a raw `Error` whose
 * message embeds the simulation/send failure text (see client.ts) — the
 * contract's own rejection is somewhere inside that string, not a
 * structured value the SDK hands back today. `decodeKeeperError` extracts
 * the numeric discriminant from that message and maps it to the named
 * variant, so a consumer can branch on `KeeperErrorCode.TaskNotFound`
 * instead of pattern-matching on message text.
 *
 * The `Error(Contract, #<n>)` shape isn't guessed: it's `soroban-env-common`'s
 * own `impl Debug for Error` (`write!(f, "Error({}, #{})", type_.name(), maj)`
 * for `ScErrorType::Contract`, whose XDR-generated name is the literal string
 * "Contract") — verified directly against that crate's source rather than
 * assumed from memory.
 */

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

/**
 * A contract call rejected with a decodable `KeeperError`, as opposed to a
 * network failure or unrelated host-level trap (see {@link decodeKeeperError}).
 */
export class KeeperContractError extends Error {
  readonly code: KeeperErrorCode;

  constructor(code: KeeperErrorCode) {
    super(`Keeper contract error: ${KeeperErrorCode[code] ?? code}`);
    this.name = "KeeperContractError";
    this.code = code;
  }
}

/**
 * Thrown by `getTask` for a task id the contract has no record of — kept
 * distinct from {@link KeeperContractError} so callers checking specifically
 * for "this task doesn't exist" don't have to match on `.code` themselves.
 */
export class TaskNotFoundError extends KeeperContractError {
  readonly taskId: number;

  constructor(taskId: number) {
    super(KeeperErrorCode.TaskNotFound);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
    this.message = `Task ${taskId} not found`;
  }
}

/**
 * Soroban RPC's `SimulateTransactionErrorResponse["error"]` (see
 * `@stellar/stellar-sdk`'s `rpc/api.d.ts`) is typed as a free-text `string`,
 * not a structured object. When the failure is a `Result::Err` the contract
 * itself returned (as opposed to a host-level trap — an `unwrap()` panic, a
 * resource-limit violation — or a network-level failure), the standard
 * Soroban host diagnostic-display format embeds the numeric error code as
 * `Error(Contract, #<code>)`. This regex is deliberately narrow — it must
 * not match a coincidental `#4` elsewhere in an unrelated error string.
 *
 * Caveat: this was checked against the documented `SimulateTransactionErrorResponse`
 * shape and the standard Soroban error-display convention, not captured from
 * a live failing call against a deployed instance of *this* contract (no
 * funded network account was available in this environment). Before this
 * ships, run the {@link decodeKeeperError} unit test's TODO against a real
 * failing call (e.g. `claim_task` on an already-claimed task) on testnet and
 * confirm the exact string this pattern is matching against.
 */
const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Extracts a typed {@link KeeperErrorCode} from a Soroban RPC simulation or
 * transaction-submission failure message, or `undefined` if the failure was
 * not a decodable contract error (a network error, or a host-level trap
 * rather than a `Result::Err` — those must not be misreported as a
 * particular `KeeperErrorCode`, since the caller could act on the wrong
 * assumption, e.g. retrying a `LockPeriodActive` read as if it were transient).
 */
export function decodeKeeperError(message: string | undefined | null): KeeperErrorCode | undefined {
  if (!message) return undefined;
  const match = CONTRACT_ERROR_PATTERN.exec(message);
  if (!match) return undefined;
  const code = Number(match[1]);
  return code in KeeperErrorCode ? (code as KeeperErrorCode) : undefined;
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
/** Every code in {@link KeeperErrorCode}, for validating a decoded number is a known variant. */
const KNOWN_CODES: ReadonlySet<number> = new Set(
  Object.values(KeeperErrorCode).filter(
    (v): v is number => typeof v === "number",
  ),
);

export interface DecodedKeeperError {
  /** The numeric discriminant exactly as it appears in the contract's error enum. */
  code: number;
  /** The matching {@link KeeperErrorCode} name, or `undefined` if `code` isn't a known variant (e.g. a newer contract than this SDK release understands). */
  name: keyof typeof KeeperErrorCode | undefined;
}

/**
 * Extracts a contract error discriminant from a Soroban error message, if
 * one is present. Soroban's own simulation/transaction-failure messages
 * embed the contract's error as `Error(Contract, #<n>)` — this looks for
 * that pattern specifically, rather than guessing from an arbitrary
 * number anywhere in the string.
 */
export function decodeKeeperError(
  error: unknown,
): DecodedKeeperError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!match) return undefined;

  const code = Number(match[1]);
  if (!KNOWN_CODES.has(code)) {
    return { code, name: undefined };
  }
  return { code, name: KeeperErrorCode[code] as keyof typeof KeeperErrorCode };
}

/**
 * Convenience predicate: does `error` decode to this specific contract error?
 *
 * @example
 * try {
 *   await client.invoke("claim_task", [...]);
 * } catch (err) {
 *   if (isKeeperError(err, KeeperErrorCode.TaskNotFound)) {
 *     // handle the specific, expected case
 *   }
 *   throw err;
 * }
 */
export function isKeeperError(error: unknown, code: KeeperErrorCode): boolean {
  return decodeKeeperError(error)?.code === code;
}
