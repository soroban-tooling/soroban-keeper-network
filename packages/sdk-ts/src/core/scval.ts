/**
 * Argument conversion helpers.
 *
 * Every wrapper builds its `ScVal` arguments through these so the numeric
 * conventions (backlog issue 0165) are applied in exactly one place: `u64`/
 * `i128` accept `bigint` or a safe `number`, `u32` stays a plain `number`, and
 * an address is always validated before it reaches the wire.
 */

import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { KeeperSdkError } from "../errors.js";

/** A `u64`/`i128` argument. `number` is accepted for convenience and checked. */
export type IntegerInput = bigint | number;

/** Converts a `G...` or `C...` address, rejecting anything else locally. */
export function addressArg(value: string, label: string): xdr.ScVal {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw new KeeperSdkError(
      `${label} must be a Stellar account (G...) or contract (C...) address, got ${JSON.stringify(value)}.`,
    );
  }
  return new Address(value).toScVal();
}

/** Converts a `u64` argument, rejecting negatives and lossy `number` inputs. */
export function u64Arg(value: IntegerInput, label: string): xdr.ScVal {
  const asBigInt = toBigInt(value, label);
  if (asBigInt < 0n) {
    throw new KeeperSdkError(`${label} must not be negative, got ${asBigInt}.`);
  }
  if (asBigInt > 18_446_744_073_709_551_615n) {
    throw new KeeperSdkError(`${label} exceeds the contract's u64 range, got ${asBigInt}.`);
  }
  return nativeToScVal(asBigInt, { type: "u64" });
}

/** Converts a `bytes` argument. */
export function bytesArg(value: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(value));
}

/**
 * Normalises an integer input to `bigint`.
 *
 * A `number` is accepted because callers frequently have one on hand, but a
 * non-integer or unsafe one is refused rather than silently rounded: a task id
 * or reward that has already lost precision in JavaScript would address the
 * wrong task or move the wrong amount.
 */
export function toBigInt(value: IntegerInput, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new KeeperSdkError(`${label} must be an integer, got ${value}.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new KeeperSdkError(
      `${label} is outside JavaScript's safe integer range and would lose precision; pass a bigint instead of ${value}.`,
    );
  }
  return BigInt(value);
}
