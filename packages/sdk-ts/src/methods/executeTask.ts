/**
 * `execute_task` -- the claiming keeper submits its proof and is credited its
 * share of the escrowed reward.
 */

import { MAX_PROOF_LEN } from "../constants.js";
import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, bytesArg, u64Arg } from "../core/scval.js";
import { KeeperContractError, KeeperErrorCode, KeeperSdkError, isKeeperError } from "../errors.js";

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
 * The outcome of an execute attempt.
 *
 * Similar to {@link ClaimTaskOutcome}, certain simulation failures during
 * execute_task are routine and expected in a competitive environment, not
 * exceptional:
 *
 * - `invalid_task_status` -- the task moved out of `Claimed` status before this
 *   keeper could execute it. This happens when another keeper executes or
 *   cancels the task, or when the task expires. Move on and try another task.
 * - `not_task_claimer` -- another keeper's lock claim is now active, usually
 *   because the previous claimer's lock lapsed and a competitor reclaimed.
 * - `deadline_passed` -- the task's deadline expired. The task is dead.
 * - `verification_failed` -- an attached verifier rejected this keeper's proof.
 *   The keeper may want to retry with different parameters or move on.
 *
 * Every other failure still rejects, since authorization errors, contract
 * pauses, or other system-level issues should propagate up and surface to the
 * operator, not be silently skipped.
 *
 * Note: simulation failures are treated as pre-submission skips, not
 * as fee-paying transactions. The calling bot must not submit a transaction
 * for any outcome other than `{ status: "executed" }`.
 */
export type ExecuteTaskOutcome =
  | { status: "executed" }
  | { status: "invalid_task_status" }
  | { status: "not_task_claimer" }
  | { status: "deadline_passed" }
  | { status: "verification_failed" };

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
 * Returns one of several routine outcomes:
 *
 * - `{ status: "executed" }` means the proof was accepted and the keeper is
 *   credited. The transaction is submitted.
 * - Other outcomes indicate the task cannot currently be executed (task moved
 *   status, another keeper holds it, deadline passed, or verifier rejected the
 *   proof). These are determined during simulation without submitting a
 *   transaction or spending a fee.
 *
 * Every other failure (authorization errors, contract paused, invalid proof
 * format) still rejects as a thrown error.
 *
 * @returns which of the five routine outcomes occurred. See
 *   {@link ExecuteTaskOutcome} for why competitive failures are return values
 *   here and not thrown exceptions.
 */
export async function executeTask(
  caller: ContractCaller,
  params: ExecuteTaskParams,
): Promise<ExecuteTaskOutcome> {
  const { keeper, taskId, proof, signer } = params;
  const bytes = toProofBytes(proof);

  if (bytes.length > MAX_PROOF_LEN) {
    throw new KeeperContractError(
      KeeperErrorCode.ProofTooLarge,
      `proof is ${bytes.length} bytes, exceeding the contract's MAX_PROOF_LEN of ${MAX_PROOF_LEN}. No transaction was built.`,
      { local: true },
    );
  }

  try {
    await caller.invoke<void>({
      method: "execute_task",
      source: keeper,
      args: [addressArg(keeper, "keeper"), u64Arg(taskId, "taskId"), bytesArg(bytes)],
      ...(signer ? { signer } : {}),
    });
    return { status: "executed" };
  } catch (error) {
    // These are routine outcomes in a competitive environment; return them
    // rather than throwing, so the caller can skip the task without logging
    // an error.
    if (isKeeperError(error, KeeperErrorCode.InvalidTaskStatus)) {
      return { status: "invalid_task_status" };
    }
    if (isKeeperError(error, KeeperErrorCode.NotTaskClaimer)) {
      return { status: "not_task_claimer" };
    }
    if (isKeeperError(error, KeeperErrorCode.DeadlinePassed)) {
      return { status: "deadline_passed" };
    }
    if (isKeeperError(error, KeeperErrorCode.VerificationFailed)) {
      return { status: "verification_failed" };
    }
    // Everything else is unexpected and should propagate.
    throw error;
  }
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
