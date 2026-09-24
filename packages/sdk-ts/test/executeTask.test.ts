import { describe, expect, it } from "vitest";

import { keypairSigner } from "../src/client.js";
import { MAX_PROOF_LEN } from "../src/constants.js";
import {
  KeeperContractError,
  KeeperErrorCode,
  KeeperRpcError,
  KeeperSdkError,
  isKeeperError,
} from "../src/errors.js";
import { toProofBytes, type ExecuteTaskOutcome } from "../src/methods/executeTask.js";
import { KEEPER, KEEPER_KEYPAIR, testClient } from "./support/client.js";

const TASK_ID = 42n;
const PROOF_HEX = "0badc0de";
const PROOF_BYTES = new Uint8Array([0x0b, 0xad, 0xc0, 0xde]);

function keeperClient(rpcOptions = {}) {
  return testClient(rpcOptions, { signer: keypairSigner(KEEPER_KEYPAIR) });
}

describe("client.executeTask", () => {
  describe("happy path", () => {
    it("submits a proof and reports success as an outcome", async () => {
      const { client, rpc } = keeperClient();

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: PROOF_BYTES,
      });

      expect(outcome).toEqual({ status: "executed" });
      expect(rpc.onlyCall.method).toBe("execute_task");
      expect(rpc.onlyCall.args[0]).toBe(KEEPER);
      expect(rpc.onlyCall.args[1]).toBe(TASK_ID);
      expect(new Uint8Array(rpc.onlyCall.args[2] as Buffer)).toEqual(PROOF_BYTES);
      expect(rpc.onlyCall.rawArgs[2]?.switch().name).toBe("scvBytes");
    });

    it("accepts Uint8Array, Buffer, and hex-string proofs as the same bytes", async () => {
      const inputs = [PROOF_BYTES, Buffer.from(PROOF_HEX, "hex"), PROOF_HEX, `0x${PROOF_HEX}`];

      for (const proof of inputs) {
        const { client, rpc } = keeperClient();
        const outcome = await client.executeTask({
          keeper: KEEPER,
          taskId: TASK_ID,
          proof,
        });
        expect(outcome).toEqual({ status: "executed" });
        expect(new Uint8Array(rpc.onlyCall.args[2] as Buffer)).toEqual(PROOF_BYTES);
      }
    });

    it("accepts a proof of exactly MAX_PROOF_LEN, matching the contract's bound", async () => {
      const { client, rpc } = keeperClient();

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: new Uint8Array(MAX_PROOF_LEN),
      });

      expect(outcome).toEqual({ status: "executed" });
      expect((rpc.onlyCall.args[2] as Buffer).length).toBe(MAX_PROOF_LEN);
    });
  });

  describe("routine competitive failures as outcomes", () => {
    it("reports InvalidTaskStatus as an outcome when task moved out of Claimed", async () => {
      const { client, rpc } = keeperClient({
        simulationErrors: { execute_task: "host invocation failed: Error(Contract, #5)" },
      });

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: PROOF_BYTES,
      });

      expect(outcome).toEqual({ status: "invalid_task_status" });
      // Most importantly: no transaction was submitted.
      expect(rpc.submitted).toHaveLength(0);
    });

    it("reports NotTaskClaimer as an outcome when another keeper holds the claim", async () => {
      const { client, rpc } = keeperClient({
        simulationErrors: { execute_task: "host invocation failed: Error(Contract, #12)" },
      });

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: PROOF_BYTES,
      });

      expect(outcome).toEqual({ status: "not_task_claimer" });
      expect(rpc.submitted).toHaveLength(0);
    });

    it("reports DeadlinePassed as an outcome when the deadline expired", async () => {
      const { client, rpc } = keeperClient({
        simulationErrors: { execute_task: "host invocation failed: Error(Contract, #6)" },
      });

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: PROOF_BYTES,
      });

      expect(outcome).toEqual({ status: "deadline_passed" });
      expect(rpc.submitted).toHaveLength(0);
    });

    it("reports VerificationFailed as an outcome when the verifier rejects the proof", async () => {
      const { client, rpc } = keeperClient({
        simulationErrors: { execute_task: "host invocation failed: Error(Contract, #24)" },
      });

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: PROOF_BYTES,
      });

      expect(outcome).toEqual({ status: "verification_failed" });
      expect(rpc.submitted).toHaveLength(0);
    });
  });

  describe("non-routine failures still throw", () => {
    it("rejects an over-length proof locally, without building a transaction", async () => {
      const { client, rpc } = keeperClient();
      const oversized = new Uint8Array(MAX_PROOF_LEN + 1);

      const rejection = await client
        .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: oversized })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.ProofTooLarge)).toBe(true);
      // Locally caught: the same code the contract would return, but no
      // simulation and no submission were paid for.
      expect((rejection as KeeperContractError).local).toBe(true);
      expect(rpc.calls).toHaveLength(0);
      expect(rpc.submitted).toHaveLength(0);
    });

    it("throws on an authorization failure, which is not a routine skip", async () => {
      const { client } = keeperClient({
        simulationErrors: { execute_task: "host invocation failed: Error(Contract, #2)" },
      });

      const rejection = await client
        .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.Unauthorized)).toBe(true);
    });

    it("throws on a contract-paused error, which is not a routine skip", async () => {
      const { client } = keeperClient({
        simulationErrors: { execute_task: "host invocation failed: Error(Contract, #3)" },
      });

      const rejection = await client
        .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES })
        .catch((error: unknown) => error);

      expect(isKeeperError(rejection, KeeperErrorCode.ContractPaused)).toBe(true);
    });

    it("reports a transport failure as an RPC error, not a contract rejection", async () => {
      const { client } = keeperClient({
        simulationErrors: {
          execute_task: "error sending request for url: connection refused",
        },
      });

      const rejection = await client
        .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES })
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(KeeperRpcError);
      expect(isKeeperError(rejection)).toBe(false);
    });
  });

  describe("outcome type safety", () => {
    it("outcome type narrows to specific statuses", async () => {
      const { client } = keeperClient();

      const outcome = await client.executeTask({
        keeper: KEEPER,
        taskId: TASK_ID,
        proof: PROOF_BYTES,
      });

      // TypeScript narrows the outcome type after checking the status.
      if (outcome.status === "executed") {
        // This is the success path; no additional data on the outcome.
        const _: typeof outcome = { status: "executed" };
      } else if (outcome.status === "invalid_task_status") {
        // Competitive failure: task moved out of Claimed.
        const _: typeof outcome = { status: "invalid_task_status" };
      } else if (outcome.status === "not_task_claimer") {
        // Competitive failure: another keeper holds the lock.
        const _: typeof outcome = { status: "not_task_claimer" };
      } else if (outcome.status === "deadline_passed") {
        // Task is dead.
        const _: typeof outcome = { status: "deadline_passed" };
      } else if (outcome.status === "verification_failed") {
        // Verifier rejected the proof.
        const _: typeof outcome = { status: "verification_failed" };
      } else {
        // Exhaustiveness check: all statuses are handled.
        const _exhaustive: never = outcome;
      }
    });
  });
});

describe("toProofBytes", () => {
  it("reads a string as hex, with or without the 0x prefix", () => {
    expect(toProofBytes(PROOF_HEX)).toEqual(PROOF_BYTES);
    expect(toProofBytes(`0x${PROOF_HEX}`)).toEqual(PROOF_BYTES);
    expect(toProofBytes("")).toEqual(new Uint8Array(0));
  });

  it("passes byte arrays through untouched", () => {
    expect(toProofBytes(PROOF_BYTES)).toEqual(PROOF_BYTES);
    expect(new Uint8Array(toProofBytes(Buffer.from(PROOF_HEX, "hex")))).toEqual(PROOF_BYTES);
  });

  it("refuses a non-hex string rather than falling back to UTF-8", () => {
    // Silently encoding "proof-of-liquidation" as UTF-8 would put entirely
    // different bytes on-chain than a caller passing a hash expects.
    expect(() => toProofBytes("proof-of-liquidation")).toThrow(KeeperSdkError);
    expect(() => toProofBytes("proof-of-liquidation")).toThrow(/read as hex/);
  });

  it("refuses an odd-length hex string", () => {
    expect(() => toProofBytes("abc")).toThrow(/odd length/);
  });
});
