/**
 * Typed decoding of the contract's error codes.
 *
 * A failed Soroban call surfaces as a numeric code buried either in a
 * simulation's rendered error string or in a failed transaction's diagnostic
 * events. Callers should never have to string-match an error message to tell
 * "this keeper has nothing to withdraw" apart from "the RPC endpoint is down",
 * so every contract rejection this SDK raises is a {@link KeeperContractError}
 * carrying a {@link KeeperErrorCode}, and every other failure is a
 * {@link KeeperRpcError}.
 */

import { xdr } from "@stellar/stellar-sdk";

/**
 * Mirror of `KeeperError` in `contracts/keeper-registry/src/errors.rs`.
 *
 * Discriminants are part of the published ABI and are decoded by number, so
 * these values must match the contract exactly. They are kept in sync per the
 * SDK versioning policy (backlog issue 0192) whenever the contract bumps
 * `VERSION`.
 */
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
  /**
   * The attached verifier rejected the keeper's proof.
   *
   * Reserved ahead of the contract: epic E04's verifier work allocates
   * discriminant 24 for this but has not landed on `main`, so no deployment
   * can return it yet. Naming it now costs nothing and means a keeper talking
   * to a verifier-enabled deployment gets a named rejection it can branch on
   * rather than a bare number.
   */
  VerificationFailed = 24,
}

/** Human-readable name, so an unknown future code still prints usefully. */
function codeName(code: number): string {
  return KeeperErrorCode[code] ?? `UnknownContractError(${code})`;
}

/** Base class for every error this SDK raises, so callers can catch one type. */
export class KeeperSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The contract rejected the call with a `Result::Err`.
 *
 * `code` is the decoded discriminant. Compare it against
 * {@link KeeperErrorCode} (or use {@link isKeeperError}) rather than matching
 * on `message`, which is informational and may change between releases.
 */
export class KeeperContractError extends KeeperSdkError {
  /**
   * True when this SDK rejected the call locally, before building a
   * transaction, by applying the same rule the contract enforces. The code is
   * the one the contract would have returned; no network call was made.
   */
  readonly local: boolean;

  constructor(
    readonly code: KeeperErrorCode | number,
    message?: string,
    options?: { local?: boolean; cause?: unknown },
  ) {
    super(message ?? `Contract call failed: ${codeName(code)} (#${code})`, {
      cause: options?.cause,
    });
    this.local = options?.local ?? false;
  }

  /** The contract's own name for this code, e.g. `"NoRewardsAvailable"`. */
  get codeName(): string {
    return codeName(this.code);
  }
}

/**
 * The call never reached a contract verdict: an RPC transport failure, a
 * malformed response, a host-level trap, or a transaction that failed for a
 * reason outside the contract's own `Result` (bad auth, insufficient fee).
 *
 * Distinguishing this from {@link KeeperContractError} matters operationally:
 * an RPC error is often worth retrying, a contract rejection never is.
 */
export class KeeperRpcError extends KeeperSdkError {}

/**
 * Narrowing helper.
 *
 * ```ts
 * catch (e) {
 *   if (isKeeperError(e, KeeperErrorCode.NoRewardsAvailable)) return 0n;
 *   throw e;
 * }
 * ```
 */
export function isKeeperError(
  error: unknown,
  code?: KeeperErrorCode | number,
): error is KeeperContractError {
  return error instanceof KeeperContractError && (code === undefined || error.code === code);
}

/**
 * Extracts a contract error discriminant from whatever Soroban RPC hands back.
 *
 * Two representations exist in practice and both are handled, because which one
 * a caller sees depends on where the call failed:
 *
 * - **Simulation** renders the failure as text containing `Error(Contract, #N)`.
 *   This is the common path: the SDK simulates before submitting, so a call the
 *   contract would reject is caught here, for free.
 * - **A submitted transaction that failed on-chain** carries the error as an
 *   `SCV_ERROR` ScVal of type `SCE_CONTRACT` inside its diagnostic events.
 *
 * Returns `undefined` when the failure is not a decodable contract error -- a
 * network error, or a host-level trap such as an arithmetic overflow, which is
 * a genuinely different thing from a `Result::Err` and must not be dressed up
 * as one.
 */
export function decodeKeeperErrorCode(source: unknown, depth = 0): number | undefined {
  if (source === undefined || source === null || depth > 4) return undefined;

  if (typeof source === "string") return codeFromText(source);

  if (Array.isArray(source)) {
    for (const entry of source) {
      const code = decodeKeeperErrorCode(entry, depth + 1);
      if (code !== undefined) return code;
    }
    return undefined;
  }

  if (typeof source === "object") {
    const fromScVal = codeFromScValLike(source);
    if (fromScVal !== undefined) return fromScVal;

    const fromEvent = codeFromDiagnosticEventLike(source, depth);
    if (fromEvent !== undefined) return fromEvent;

    const record = source as Record<string, unknown>;
    for (const key of ["error", "message", "diagnosticEventsXdr", "events"]) {
      const code = decodeKeeperErrorCode(record[key], depth + 1);
      if (code !== undefined) return code;
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

/** `Error(Contract, #13)` is the host's rendering of a contract `Result::Err`. */
function codeFromText(text: string): number | undefined {
  const rendered = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  if (rendered?.[1] !== undefined) return Number(rendered[1]);

  // Some RPC versions render the same failure through the ScError type names.
  const scContract = /ScErrorType::Contract[\s\S]{0,160}?#(\d+)/.exec(text);
  if (scContract?.[1] !== undefined) return Number(scContract[1]);

  return undefined;
}

/**
 * Reads a contract code out of an `xdr.ScVal`.
 *
 * Only `SCV_ERROR` values whose error type is `SCE_CONTRACT` are ours: a
 * `SCE_WASM_VM` or `SCE_BUDGET` error is a host-level failure, not a value the
 * contract chose to return, and must not be reported as a `KeeperErrorCode`.
 */
function codeFromScValLike(value: object): number | undefined {
  const candidate = value as { switch?: () => { name?: string }; error?: () => unknown };
  if (typeof candidate.switch !== "function" || typeof candidate.error !== "function") {
    return undefined;
  }
  try {
    if (candidate.switch().name !== xdr.ScValType.scvError().name) return undefined;
    const scError = candidate.error() as {
      switch: () => { name: string };
      contractCode: () => number;
    };
    if (scError.switch().name !== xdr.ScErrorType.sceContract().name) return undefined;
    return scError.contractCode();
  } catch {
    return undefined;
  }
}

/** Walks a diagnostic event's topics and data looking for the error ScVal. */
function codeFromDiagnosticEventLike(value: object, depth: number): number | undefined {
  const candidate = value as { event?: () => { body?: () => unknown } };
  if (typeof candidate.event !== "function") return undefined;
  try {
    const body = candidate.event().body?.() as
      | { v0?: () => { topics: () => unknown[]; data: () => unknown } }
      | undefined;
    const v0 = body?.v0?.();
    if (!v0) return undefined;
    return decodeKeeperErrorCode([...v0.topics(), v0.data()], depth + 1);
  } catch {
    return undefined;
  }
}

/** Best-effort human-readable rendering of a raw failure, for error messages. */
function errorText(source: unknown): string | undefined {
  if (source === undefined || source === null) return undefined;
  if (typeof source === "string") return source;
  if (source instanceof Error) return source.message;
  if (typeof source === "object") {
    const candidate = source as { error?: unknown; message?: unknown };
    if (typeof candidate.error === "string") return candidate.error;
    if (typeof candidate.message === "string") return candidate.message;
    try {
      return JSON.stringify(source);
    } catch {
      return undefined;
    }
  }
  return String(source);
}

/**
 * Turns any failure from a contract call into the right typed error.
 *
 * @param source the raw failure: a thrown value, a simulation response, or a
 *   failed transaction response
 * @param context short description of what was attempted, used in the message
 */
export function toKeeperError(source: unknown, context: string): KeeperSdkError {
  if (source instanceof KeeperSdkError) return source;

  const code = decodeKeeperErrorCode(source);
  if (code !== undefined) {
    return new KeeperContractError(code, `${context}: ${codeName(code)} (#${code})`, {
      cause: source,
    });
  }

  return new KeeperRpcError(`${context}: ${errorText(source) ?? String(source)}`, {
    cause: source,
  });
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
