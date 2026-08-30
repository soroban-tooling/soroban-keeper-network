// Typed decoding of the contract's error codes. Mirrors
// `contracts/keeper-registry/src/errors.rs::KeeperError` exactly — discriminants
// are part of the published ABI, never renumber an existing variant here
// without renumbering it there too.

/** Mirrors `contracts/keeper-registry/src/errors.rs::KeeperError`. */
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
}
