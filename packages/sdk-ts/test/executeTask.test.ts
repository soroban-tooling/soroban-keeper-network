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
import { toProofBytes } from "../src/methods/executeTask.js";
import { KEEPER, KEEPER_KEYPAIR, testClient } from "./support/client.js";

const TASK_ID = 42n;
const PROOF_HEX = "0badc0de";
const PROOF_BYTES = new Uint8Array([0x0b, 0xad, 0xc0, 0xde]);

function keeperClient(rpcOptions = {}) {
  return testClient(rpcOptions, { signer: keypairSigner(KEEPER_KEYPAIR) });
}

describe("client.executeTask", () => {
  it("submits a proof and reports success", async () => {
    const { client, rpc } = keeperClient();

    await expect(
      client.executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES }),
    ).resolves.toBeUndefined();

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
      await client.executeTask({ keeper: KEEPER, taskId: TASK_ID, proof });
      expect(new Uint8Array(rpc.onlyCall.args[2] as Buffer)).toEqual(PROOF_BYTES);
    }
  });

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

  it("accepts a proof of exactly MAX_PROOF_LEN, matching the contract's bound", async () => {
    const { client, rpc } = keeperClient();

    await client.executeTask({
      keeper: KEEPER,
      taskId: TASK_ID,
      proof: new Uint8Array(MAX_PROOF_LEN),
    });

    expect((rpc.onlyCall.args[2] as Buffer).length).toBe(MAX_PROOF_LEN);
  });

  it("surfaces a verifier rejection as VerificationFailed, distinctly from a size failure", async () => {
    // The verifier-gated execute_task of epic E04 rejects a bad proof with
    // contract error 24 once submitted, rather than at simulation time.
    const { client } = keeperClient({ onChainFailures: { execute_task: 24 } });

    const rejection = await client
      .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.VerificationFailed)).toBe(true);
    expect(isKeeperError(rejection, KeeperErrorCode.ProofTooLarge)).toBe(false);
    expect((rejection as KeeperContractError).codeName).toBe("VerificationFailed");
    expect((rejection as KeeperContractError).local).toBe(false);
  });

  it("surfaces an over-length proof the contract caught as a non-local ProofTooLarge", async () => {
    // The SDK's copy of MAX_PROOF_LEN is only a pre-check; if it ever drifts
    // above the deployed contract's, the contract stays authoritative and the
    // caller still gets the same typed code.
    const { client } = keeperClient({
      simulationErrors: { execute_task: "host invocation failed: Error(Contract, #14)" },
    });

    const rejection = await client
      .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES })
      .catch((error: unknown) => error);

    expect(isKeeperError(rejection, KeeperErrorCode.ProofTooLarge)).toBe(true);
    expect((rejection as KeeperContractError).local).toBe(false);
  });

  it("reports a transport failure as an RPC error, not a contract rejection", async () => {
    const { client } = keeperClient({
      simulationErrors: { execute_task: "error sending request for url: connection refused" },
    });

    const rejection = await client
      .executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(KeeperRpcError);
    expect(isKeeperError(rejection)).toBe(false);
  });

  it("surfaces NotTaskClaimer when another keeper holds the claim", async () => {
    const { client } = keeperClient({
      simulationErrors: { execute_task: "host invocation failed: Error(Contract, #12)" },
    });

    await expect(
      client.executeTask({ keeper: KEEPER, taskId: TASK_ID, proof: PROOF_BYTES }),
    ).rejects.toMatchObject({ code: KeeperErrorCode.NotTaskClaimer });
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
