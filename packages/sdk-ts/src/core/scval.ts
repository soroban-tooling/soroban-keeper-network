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

/**
 * Converts an `Option<Address>` argument.
 *
 * Soroban encodes `None` as void and `Some(x)` as `x` itself, so an omitted
 * optional address is a real argument that must still be passed -- dropping it
 * would shift every later positional argument.
 */
export function optionalAddressArg(value: string | undefined, label: string): xdr.ScVal {
  return value === undefined ? xdr.ScVal.scvVoid() : addressArg(value, label);
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

/**
 * Converts a `u32` argument.
 *
 * `u32` stays a plain `number` per the numeric convention, so this rejects a
 * non-integer or out-of-range value rather than letting `nativeToScVal` coerce
 * it -- a fee in basis points that silently wrapped would be a real loss.
 */
export function u32Arg(value: number, label: string): xdr.ScVal {
  if (!Number.isInteger(value)) {
    throw new KeeperSdkError(`${label} must be an integer, got ${value}.`);
  }
  if (value < 0 || value > 4_294_967_295) {
    throw new KeeperSdkError(`${label} exceeds the contract's u32 range, got ${value}.`);
  }
  return nativeToScVal(value, { type: "u32" });
}

/** Converts an `i128` argument, accepting a `bigint` or a safe `number`. */
export function i128Arg(value: IntegerInput, label: string): xdr.ScVal {
  return nativeToScVal(toBigInt(value, label), { type: "i128" });
}

/**
 * Converts a `BytesN<32>` argument -- a contract WASM hash.
 *
 * The length is checked here rather than left to the encoder: a hash of the
 * wrong length otherwise surfaces as an opaque XDR failure well away from the
 * argument that caused it.
 */
export function bytesN32Arg(value: Uint8Array, label: string): xdr.ScVal {
  if (value.length !== 32) {
    throw new KeeperSdkError(`${label} must be exactly 32 bytes, got ${value.length}.`);
  }
  return xdr.ScVal.scvBytes(Buffer.from(value));
}
