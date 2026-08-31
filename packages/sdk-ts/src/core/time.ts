/**
 * The SDK's one implementation of the timestamp convention.
 *
 * Decision (backlog issue 0165): every method that takes a Unix-second
 * timestamp accepts `Date | number | bigint` and normalises here, and every
 * view that returns one hands back a `Date`.
 *
 * Accepting all three is not indecision. The two consumers this SDK targets
 * arrive with different values in hand: application code holds a `Date`, while
 * a keeper bot already computes `Math.floor(Date.now() / 1000)` (see
 * `examples/keeper-bot/index.js`) and would otherwise wrap it back into a
 * `Date` only for the SDK to unwrap it again. The ambiguity that would make
 * accepting both dangerous -- milliseconds versus seconds -- cannot arise,
 * because a `Date` is unambiguous and a bare number is documented, checked, and
 * only ever read as seconds.
 */

import { KeeperSdkError } from "../errors.js";

/**
 * A Unix-second timestamp at an SDK method boundary.
 *
 * Inputs accept all three shapes and are normalised by {@link toUnixSeconds}:
 * a `Date` (the ergonomic choice for application code), or a `number`/`bigint`
 * of raw Unix *seconds* (what a keeper bot already has on hand). Values handed
 * back out of view methods are `Date`.
 */
export type TimestampInput = Date | number | bigint;

/**
 * Milliseconds-as-seconds guard.
 *
 * A caller who passes `Date.now()` where seconds are expected produces a
 * timestamp around the year 54,000 -- comfortably inside `u64`, so neither this
 * SDK nor the contract would otherwise notice, and the task would simply never
 * expire. Any bare number this far in the future is a unit mistake, not a real
 * deadline, so it is rejected at the boundary where the fix is obvious.
 *
 * The cutoff is the year 10,000 in Unix seconds.
 */
const IMPLAUSIBLE_SECONDS = 253_402_300_800n;

/**
 * Converts a {@link TimestampInput} to Unix seconds.
 *
 * @param value a `Date`, or a `number`/`bigint` of Unix *seconds*
 * @param label the parameter name, used in error messages
 */
export function toUnixSeconds(value: TimestampInput, label: string): bigint {
  const seconds = normalise(value, label);

  if (seconds < 0n) {
    throw new KeeperSdkError(`${label} must not be before the Unix epoch, got ${seconds}.`);
  }
  if (seconds >= IMPLAUSIBLE_SECONDS) {
    throw new KeeperSdkError(
      `${label} is ${seconds}, which is past the year 10000 when read as Unix seconds. ` +
        `If this came from Date.now(), pass the Date itself or divide by 1000.`,
    );
  }
  return seconds;
}

function normalise(value: TimestampInput, label: string): bigint {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new KeeperSdkError(`${label} is an Invalid Date.`);
    }
    // Truncate rather than round: a deadline must never land earlier than the
    // instant the caller named.
    return BigInt(Math.floor(ms / 1000));
  }
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new KeeperSdkError(`${label} must be a finite number of Unix seconds, got ${value}.`);
    }
    if (!Number.isInteger(value)) {
      throw new KeeperSdkError(
        `${label} must be a whole number of Unix seconds, got ${value}. ` +
          `Use Math.floor, or pass a Date.`,
      );
    }
    return BigInt(value);
  }
  throw new KeeperSdkError(
    `${label} must be a Date, or a number/bigint of Unix seconds, got ${typeof value}.`,
  );
}

/** Converts contract-returned Unix seconds to a `Date`, per the same decision. */
export function fromUnixSeconds(seconds: bigint | number): Date {
  return new Date(Number(seconds) * 1000);
}
