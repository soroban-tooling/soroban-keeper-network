/**
 * `execute_task` -- the claiming keeper submits its proof and is credited its
 * share of the escrowed reward.
 */

import { MAX_PROOF_LEN } from "../constants.js";
import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, bytesArg, u64Arg } from "../core/scval.js";
import { KeeperContractError, KeeperErrorCode, KeeperSdkError } from "../errors.js";

/**
 * Accepted proof representations.
 *
 * - `Uint8Array` / `Buffer` -- used as-is, byte for byte.
 * - `string` -- **always decoded as hex**, with an optional `0x` prefix. This
 *   matches the existing keeper-bot, which passes `Buffer.from(proof, "hex")`,
 *   and matches what a proof actually is in practice: a transaction hash or a
 *   state witness. A string that is not valid hex is rejected rather than
 *   falling back to UTF-8, because guessing between the two encodings would
 *   put different bytes on-chain than the caller intended, and the mistake
 *   would only surface as a proof that verifies against nothing.
 *
 * To submit UTF-8 text as a proof, encode it explicitly:
 * `new TextEncoder().encode(text)`.
 */
export type ProofInput = Uint8Array | string;

export interface ExecuteTaskParams extends SignedCallOptions {
  /** `G...` address of the keeper holding the claim. Must authorize the call. */
  keeper: string;
  /** Id of the claimed task being executed. */
  taskId: IntegerInput;
  /** Proof of off-chain execution. See {@link ProofInput} for the formats. */
  proof: ProofInput;
}

/**
 * Submits proof of execution for a task this keeper has claimed.
 *
 * The proof is length-checked locally against {@link MAX_PROOF_LEN} before any
 * transaction is built, so an oversized proof costs a thrown error instead of a
 * simulation round trip. The check is an optimisation only -- the contract's
 * own `ProofTooLarge` guard stays authoritative, and the SDK's copy of the
 * constant is kept in sync with it per the versioning policy (backlog issue
 * 0192).
 *
 * Rejects with a `KeeperContractError` carrying, among others:
 * - `ProofTooLarge` when the proof exceeds `MAX_PROOF_LEN`; `error.local` is
 *   `true` when this SDK caught it before submitting,
 * - `NotTaskClaimer` when another keeper currently holds the claim,
 * - `InvalidTaskStatus` when the task is not in `Claimed`,
 * - `DeadlinePassed` when the deadline elapsed before execution,
 * - `VerificationFailed` when an attached verifier rejects the proof (once
 *   epic E04's verifier work lands; the code is reserved and decoded already).
 */
export async function executeTask(
  caller: ContractCaller,
  params: ExecuteTaskParams,
): Promise<void> {
  const { keeper, taskId, proof, signer } = params;
  const bytes = toProofBytes(proof);

  if (bytes.length > MAX_PROOF_LEN) {
    throw new KeeperContractError(
      KeeperErrorCode.ProofTooLarge,
      `proof is ${bytes.length} bytes, exceeding the contract's MAX_PROOF_LEN of ${MAX_PROOF_LEN}. No transaction was built.`,
      { local: true },
    );
  }

  await caller.invoke<void>({
    method: "execute_task",
    source: keeper,
    args: [addressArg(keeper, "keeper"), u64Arg(taskId, "taskId"), bytesArg(bytes)],
    ...(signer ? { signer } : {}),
  });
}

/** Normalises any {@link ProofInput} to the bytes the contract expects. */
export function toProofBytes(proof: ProofInput): Uint8Array {
  if (typeof proof !== "string") {
    if (!(proof instanceof Uint8Array)) {
      throw new KeeperSdkError(
        `proof must be a Uint8Array, a Buffer, or a hex string, got ${typeof proof}.`,
      );
    }
    return proof;
  }

  const hex = proof.startsWith("0x") || proof.startsWith("0X") ? proof.slice(2) : proof;
  if (hex.length === 0) return new Uint8Array(0);
  if (hex.length % 2 !== 0) {
    throw new KeeperSdkError(
      `proof is a string and is therefore read as hex, but it has an odd length (${hex.length}). ` +
        `To submit text, encode it first: new TextEncoder().encode(text).`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new KeeperSdkError(
      `proof is a string and is therefore read as hex, but it contains non-hex characters. ` +
        `To submit text, encode it first: new TextEncoder().encode(text).`,
    );
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
