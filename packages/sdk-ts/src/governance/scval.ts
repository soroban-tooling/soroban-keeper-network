/**
 * Argument conversion and ScVal decoding helpers for the governance client.
 */

import { Address, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { GovernanceSdkError } from "./errors.js";
import { GovernableAction, Proposal, ProposalStatus, VoteType } from "./types.js";

export type IntegerInput = bigint | number;

/** Converts a `G...` or `C...` address, rejecting anything else locally. */
export function addressArg(value: string, label: string): xdr.ScVal {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw new GovernanceSdkError(
      `${label} must be a Stellar account (G...) or contract (C...) address, got ${JSON.stringify(value)}.`,
    );
  }
  return new Address(value).toScVal();
}

/**
 * Normalises an integer input to `bigint`.
 */
export function toBigInt(value: IntegerInput, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new GovernanceSdkError(`${label} must be an integer, got ${value}.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new GovernanceSdkError(
      `${label} is outside JavaScript's safe integer range and would lose precision; pass a bigint instead of ${value}.`,
    );
  }
  return BigInt(value);
}

/** Converts a `u32` argument. */
export function u32Arg(value: number, label: string): xdr.ScVal {
  if (!Number.isInteger(value)) {
    throw new GovernanceSdkError(`${label} must be an integer, got ${value}.`);
  }
  if (value < 0 || value > 4_294_967_295) {
    throw new GovernanceSdkError(`${label} exceeds the contract's u32 range, got ${value}.`);
  }
  return nativeToScVal(value, { type: "u32" });
}

/** Converts a `u64` argument. */
export function u64Arg(value: IntegerInput, label: string): xdr.ScVal {
  const big = toBigInt(value, label);
  if (big < 0n || big > 18_446_744_073_709_551_615n) {
    throw new GovernanceSdkError(`${label} exceeds the contract's u64 range, got ${value}.`);
  }
  return nativeToScVal(big, { type: "u64" });
}

/** Converts an `i128` argument. */
export function i128Arg(value: IntegerInput, label: string): xdr.ScVal {
  return nativeToScVal(toBigInt(value, label), { type: "i128" });
}

/**
 * Converts a `GovernableAction` to its Soroban enum ScVal representation.
 */
export function actionToScVal(action: GovernableAction): xdr.ScVal {
  switch (action.type) {
    case "SetFeeBps":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetFeeBps"),
        u32Arg(action.newBps, "newBps"),
      ]);
    case "SetMinReward":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetMinReward"),
        i128Arg(action.minReward, "minReward"),
      ]);
    case "SetReputationFloor":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetReputationFloor"),
        u32Arg(action.floorBps, "floorBps"),
      ]);
    case "Pause":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Pause")]);
    case "Unpause":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Unpause")]);
    default:
      throw new GovernanceSdkError(`Unknown GovernableAction: ${JSON.stringify(action)}`);
  }
}

/**
 * Decodes a GovernableAction from a native or ScVal representation.
 */
export function decodeAction(raw: unknown): GovernableAction {
  if (typeof raw === "string") {
    if (raw === "Pause") return { type: "Pause" };
    if (raw === "Unpause") return { type: "Unpause" };
  }
  if (Array.isArray(raw)) {
    const [name, val] = raw;
    if (name === "SetFeeBps") return { type: "SetFeeBps", newBps: Number(val) };
    if (name === "SetMinReward") return { type: "SetMinReward", minReward: BigInt(val) };
    if (name === "SetReputationFloor") return { type: "SetReputationFloor", floorBps: Number(val) };
    if (name === "Pause") return { type: "Pause" };
    if (name === "Unpause") return { type: "Unpause" };
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if ("SetFeeBps" in record) return { type: "SetFeeBps", newBps: Number(record.SetFeeBps) };
    if ("SetMinReward" in record) return { type: "SetMinReward", minReward: BigInt(record.SetMinReward as string | number | bigint) };
    if ("SetReputationFloor" in record) return { type: "SetReputationFloor", floorBps: Number(record.SetReputationFloor) };
    if ("Pause" in record) return { type: "Pause" };
    if ("Unpause" in record) return { type: "Unpause" };
  }
  throw new GovernanceSdkError(`Cannot decode GovernableAction: ${JSON.stringify(raw)}`);
}

/**
 * Decodes a raw Soroban ScVal or native JS representation into a typed `Proposal`.
 */
export function scValToProposal(val: xdr.ScVal | unknown): Proposal {
  const native = val instanceof xdr.ScVal ? scValToNative(val) : val;
  if (!native || typeof native !== "object") {
    throw new GovernanceSdkError(`Expected Proposal object, got ${JSON.stringify(native)}`);
  }
  const obj = native as Record<string, unknown>;

  const id = BigInt(obj.id as string | number | bigint);
  const proposer = String(obj.proposer);
  const action = decodeAction(obj.action);
  const eta = BigInt(obj.eta as string | number | bigint);

  let status: ProposalStatus;
  if (typeof obj.status === "number" || typeof obj.status === "bigint") {
    status = Number(obj.status) as ProposalStatus;
  } else if (typeof obj.status === "string") {
    status = (ProposalStatus as unknown as Record<string, ProposalStatus>)[obj.status] ?? ProposalStatus.Pending;
  } else {
    status = ProposalStatus.Pending;
  }

  return { id, proposer, action, eta, status };
}
