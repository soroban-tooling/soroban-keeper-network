/**
 * Typed decoding of the governance contract's error codes (issue #502 / backlog 0374).
 *
 * Mirrors `contracts/governance/src/lib.rs::GovernanceError` exactly — same
 * names, same discriminants.
 */

import { xdr } from "@stellar/stellar-sdk";

export enum GovernanceErrorCode {
  AlreadyInitialized = 1,
  NotInitialized = 2,
  InsufficientProposerBalance = 3,
  InvalidParameterValue = 4,
  ProposalNotFound = 5,
  VotingEnded = 6,
  VotingStillActive = 7,
  AlreadyVoted = 8,
  QuorumNotMet = 9,
  PassingThresholdNotMet = 10,
  TimelockNotElapsed = 11,
  ProposalAlreadyExecuted = 12,
  ProposalNotQueued = 13,
  RegistryCallFailed = 14,
  Unauthorized = 15,
  ArithmeticOverflow = 16,
  InsufficientVotingPower = 17,
  ProposalAlreadyCancelled = 18,
  CannotCancelExecuted = 19,
}

/** Human-readable name, so an unknown future code still prints usefully. */
function codeName(code: number): string {
  return GovernanceErrorCode[code] ?? `UnknownContractError(${code})`;
}

/** Base class for every error the governance client raises. */
export class GovernanceSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The contract rejected the call with a `Result::Err(GovernanceError)`.
 */
export class GovernanceContractError extends GovernanceSdkError {
  readonly local: boolean;

  constructor(
    readonly code: GovernanceErrorCode | number,
    message?: string,
    options?: { local?: boolean; cause?: unknown },
  ) {
    super(message ?? `Governance contract call failed: ${codeName(code)} (#${code})`, {
      cause: options?.cause,
    });
    this.local = options?.local ?? false;
  }

  get codeName(): string {
    return codeName(this.code);
  }
}

/**
 * The call never reached a contract verdict: RPC transport error, simulation failure, etc.
 */
export class GovernanceRpcError extends GovernanceSdkError {}

/** Narrowing helper, mirroring `isTreasuryError` and `isKeeperError`. */
export function isGovernanceError(
  error: unknown,
  code?: GovernanceErrorCode | number,
): error is GovernanceContractError {
  return (
    error instanceof GovernanceContractError &&
    (code === undefined || error.code === code)
  );
}

/**
 * Extracts a contract error discriminant from simulation failure strings or diagnostic events.
 */
export function decodeGovernanceErrorCode(source: unknown, depth = 0): number | undefined {
  if (source === undefined || source === null || depth > 4) return undefined;

  if (typeof source === "string") return codeFromText(source);

  if (Array.isArray(source)) {
    for (const entry of source) {
      const code = decodeGovernanceErrorCode(entry, depth + 1);
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
      const code = decodeGovernanceErrorCode(record[key], depth + 1);
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
    return decodeGovernanceErrorCode([...v0.topics(), v0.data()], depth + 1);
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
 * Turns any failure from a governance contract call into the right typed error.
 */
export function toGovernanceError(source: unknown, context: string): GovernanceSdkError {
  if (source instanceof GovernanceSdkError) return source;

  const code = decodeGovernanceErrorCode(source);
  if (code !== undefined) {
    return new GovernanceContractError(code, `${context}: ${codeName(code)} (#${code})`, {
      cause: source,
    });
  }

  return new GovernanceRpcError(`${context}: ${errorText(source) ?? String(source)}`, {
    cause: source,
  });
}
