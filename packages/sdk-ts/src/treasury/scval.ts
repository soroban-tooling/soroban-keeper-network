/**
 * Argument conversion helpers for the treasury client.
 *
 * Same numeric conventions as `../core/scval.ts` (backlog issue 0165):
 * `i128` accepts `bigint` or a safe `number`, `u32` stays a plain `number`,
 * an address is always validated before it reaches the wire. Kept as its own
 * copy rather than imported from `../core/scval.ts` so this module raises
 * only `TreasurySdkError`, never the registry client's `KeeperSdkError`.
 */

import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { TreasurySdkError } from "./errors.js";

/** A `u64`/`i128` argument. `number` is accepted for convenience and checked. */
export type IntegerInput = bigint | number;

/** Converts a `G...` or `C...` address, rejecting anything else locally. */
export function addressArg(value: string, label: string): xdr.ScVal {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw new TreasurySdkError(
      `${label} must be a Stellar account (G...) or contract (C...) address, got ${JSON.stringify(value)}.`,
    );
  }
  return new Address(value).toScVal();
}

/**
 * Normalises an integer input to `bigint`. A non-integer or unsafe `number`
 * is refused rather than silently rounded.
 */
export function toBigInt(value: IntegerInput, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new TreasurySdkError(`${label} must be an integer, got ${value}.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TreasurySdkError(
      `${label} is outside JavaScript's safe integer range and would lose precision; pass a bigint instead of ${value}.`,
    );
  }
  return BigInt(value);
}

/** Converts a `u32` argument. */
export function u32Arg(value: number, label: string): xdr.ScVal {
  if (!Number.isInteger(value)) {
    throw new TreasurySdkError(`${label} must be an integer, got ${value}.`);
  }
  if (value < 0 || value > 4_294_967_295) {
    throw new TreasurySdkError(`${label} exceeds the contract's u32 range, got ${value}.`);
  }
  return nativeToScVal(value, { type: "u32" });
}

/** Converts an `i128` argument, accepting a `bigint` or a safe `number`. */
export function i128Arg(value: IntegerInput, label: string): xdr.ScVal {
  return nativeToScVal(toBigInt(value, label), { type: "i128" });
}

/**
 * Converts a `BytesN<32>` argument — a contract WASM hash. Length-checked
 * locally rather than left to the encoder.
 */
export function bytesN32Arg(value: Uint8Array, label: string): xdr.ScVal {
  if (value.length !== 32) {
    throw new TreasurySdkError(`${label} must be exactly 32 bytes, got ${value.length}.`);
  }
  return xdr.ScVal.scvBytes(Buffer.from(value));
}
