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
