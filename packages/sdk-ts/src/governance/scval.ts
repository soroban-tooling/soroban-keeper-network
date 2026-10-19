/**
 * Argument conversion and ScVal helpers for the governance client.
 */

import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { GovernanceSdkError } from "./errors.js";
import type { GovernableAction, VoteChoice } from "./types.js";

export type IntegerInput = bigint | number;

export function addressArg(value: string, label: string): xdr.ScVal {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw new GovernanceSdkError(
      `${label} must be a Stellar account (G...) or contract (C...) address, got ${JSON.stringify(value)}.`,
    );
  }
  return new Address(value).toScVal();
}

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

export function u32Arg(value: number, label: string): xdr.ScVal {
  if (!Number.isInteger(value)) {
    throw new GovernanceSdkError(`${label} must be an integer, got ${value}.`);
  }
  if (value < 0 || value > 4_294_967_295) {
    throw new GovernanceSdkError(`${label} exceeds the contract's u32 range, got ${value}.`);
  }
  return nativeToScVal(value, { type: "u32" });
}

export function u64Arg(value: IntegerInput, label: string): xdr.ScVal {
  return nativeToScVal(toBigInt(value, label), { type: "u64" });
}

export function i128Arg(value: IntegerInput, label: string): xdr.ScVal {
  return nativeToScVal(toBigInt(value, label), { type: "i128" });
}

export function bytesN32Arg(value: Uint8Array, label: string): xdr.ScVal {
  if (value.length !== 32) {
    throw new GovernanceSdkError(`${label} must be exactly 32 bytes, got ${value.length}.`);
  }
  return xdr.ScVal.scvBytes(Buffer.from(value));
}

export function voteChoiceArg(choice: VoteChoice): xdr.ScVal {
  return nativeToScVal(choice, { type: "u32" });
}

/**
 * Encodes a GovernableAction into an ScVal Enum.
 */
export function governableActionArg(action: GovernableAction): xdr.ScVal {
  switch (action.type) {
    case "SetFeeBps":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetFeeBps"),
        u32Arg(action.bps, "bps"),
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
    case "PauseRegistry":
      return xdr.ScVal.scvSymbol("PauseRegistry");
    case "UnpauseRegistry":
      return xdr.ScVal.scvSymbol("UnpauseRegistry");
    case "TransferRegistryAdmin":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("TransferRegistryAdmin"),
        addressArg(action.newAdmin, "newAdmin"),
      ]);
    case "AddTreasuryRecipient":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("AddTreasuryRecipient"),
        addressArg(action.recipient, "recipient"),
        u32Arg(action.sharesBps, "sharesBps"),
      ]);
    case "RemoveTreasuryRecipient":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("RemoveTreasuryRecipient"),
        addressArg(action.recipient, "recipient"),
      ]);
    case "UpdateTreasuryShares":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("UpdateTreasuryShares"),
        addressArg(action.recipient, "recipient"),
        u32Arg(action.newSharesBps, "newSharesBps"),
      ]);
    case "PauseTreasury":
      return xdr.ScVal.scvSymbol("PauseTreasury");
    case "UnpauseTreasury":
      return xdr.ScVal.scvSymbol("UnpauseTreasury");
    case "SetVotingPeriod":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetVotingPeriod"),
        u32Arg(action.votingPeriod, "votingPeriod"),
      ]);
    case "SetTimelockDelay":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetTimelockDelay"),
        u32Arg(action.timelockDelay, "timelockDelay"),
      ]);
    case "SetQuorumBps":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetQuorumBps"),
        u32Arg(action.quorumBps, "quorumBps"),
      ]);
    case "SetProposalThreshold":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("SetProposalThreshold"),
        i128Arg(action.proposalThreshold, "proposalThreshold"),
      ]);
    case "UpgradeRegistry":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("UpgradeRegistry"),
        bytesN32Arg(action.wasmHash, "wasmHash"),
      ]);
    case "UpgradeTreasury":
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("UpgradeTreasury"),
        bytesN32Arg(action.wasmHash, "wasmHash"),
      ]);
  }
}
