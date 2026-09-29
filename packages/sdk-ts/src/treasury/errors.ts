/**
 * Typed decoding of the treasury contract's error codes.
 *
 * Mirrors `contracts/treasury/src/errors.rs::TreasuryError` exactly — same
 * names, same discriminants. That file's own doc comment states the
 * discriminants are part of the published ABI and are never renumbered, only
 * appended to, which is what makes decoding by number safe here rather than
 * fragile.
 *
 * The decoding logic itself (pulling a numeric code out of a simulation's
 * rendered error text or a failed transaction's diagnostic events) is the
 * same shape as `../errors.ts`'s for the keeper-registry contract, kept as
 * its own copy here rather than shared: the two contracts are separate
 * deployments with separate error enums, and a shared "decode a contract
 * error" helper parameterized by enum would buy very little over one small
 * self-contained module per client.
 */

import { xdr } from "@stellar/stellar-sdk";

export enum TreasuryErrorCode {
  AlreadyInitialized = 1,
  Unauthorized = 2,
  ContractPaused = 3,
  NotInitialized = 4,
  RecipientNotFound = 5,
  RecipientAlreadyExists = 6,
  InvalidShares = 7,
  NoRecipients = 8,
  InvalidAmount = 9,
  NoRewardsAvailable = 10,
  ArithmeticOverflow = 11,
  TooManyRecipients = 12,
}

/** Human-readable name, so an unknown future code still prints usefully. */
function codeName(code: number): string {
  return TreasuryErrorCode[code] ?? `UnknownContractError(${code})`;
}

/** Base class for every error this client raises, so callers can catch one type. */
export class TreasurySdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The contract rejected the call with a `Result::Err`.
 *
 * `code` is the decoded discriminant. Compare it against
 * {@link TreasuryErrorCode} (or use {@link isTreasuryError}) rather than
 * matching on `message`, which is informational and may change between
 * releases.
 */
export class TreasuryContractError extends TreasurySdkError {
  /**
   * True when this client rejected the call locally, before building a
   * transaction, by applying the same rule the contract enforces. The code is
   * the one the contract would have returned; no network call was made.
   */
  readonly local: boolean;

  constructor(
    readonly code: TreasuryErrorCode | number,
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
 */
export class TreasuryRpcError extends TreasurySdkError {}

/** Narrowing helper, mirroring `isKeeperError` for the registry client. */
export function isTreasuryError(
  error: unknown,
  code?: TreasuryErrorCode | number,
): error is TreasuryContractError {
  return error instanceof TreasuryContractError && (code === undefined || error.code === code);
}

/**
 * Extracts a contract error discriminant from whatever Soroban RPC hands
 * back. See `../errors.ts::decodeKeeperErrorCode` for the two
 * representations this walks (a rendered simulation-failure string, or a
 * failed transaction's diagnostic events) — identical logic, contract-agnostic.
 */
export function decodeTreasuryErrorCode(source: unknown, depth = 0): number | undefined {
  if (source === undefined || source === null || depth > 4) return undefined;

  if (typeof source === "string") return codeFromText(source);

  if (Array.isArray(source)) {
    for (const entry of source) {
      const code = decodeTreasuryErrorCode(entry, depth + 1);
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
      const code = decodeTreasuryErrorCode(record[key], depth + 1);
      if (code !== undefined) return code;
    }
  }

  return undefined;
}

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

function codeFromText(text: string): number | undefined {
  const rendered = CONTRACT_ERROR_PATTERN.exec(text);
  if (rendered?.[1] !== undefined) return Number(rendered[1]);

  const scContract = /ScErrorType::Contract[\s\S]{0,160}?#(\d+)/.exec(text);
  if (scContract?.[1] !== undefined) return Number(scContract[1]);

  return undefined;
}

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

function codeFromDiagnosticEventLike(value: object, depth: number): number | undefined {
  const candidate = value as { event?: () => { body?: () => unknown } };
  if (typeof candidate.event !== "function") return undefined;
  try {
    const body = candidate.event().body?.() as
      | { v0?: () => { topics: () => unknown[]; data: () => unknown } }
      | undefined;
    const v0 = body?.v0?.();
    if (!v0) return undefined;
    return decodeTreasuryErrorCode([...v0.topics(), v0.data()], depth + 1);
  } catch {
    return undefined;
  }
}

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
export function toTreasuryError(source: unknown, context: string): TreasurySdkError {
  if (source instanceof TreasurySdkError) return source;

  const code = decodeTreasuryErrorCode(source);
  if (code !== undefined) {
    return new TreasuryContractError(code, `${context}: ${codeName(code)} (#${code})`, {
      cause: source,
    });
  }

  return new TreasuryRpcError(`${context}: ${errorText(source) ?? String(source)}`, {
    cause: source,
  });
}
