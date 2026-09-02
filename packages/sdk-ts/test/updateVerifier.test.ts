import test from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, rpc, Networks, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { KeeperRegistryClient } from "../src/client";
import { updateVerifier } from "../src/methods/updateVerifier";
import { getRequiredSigners } from "../src/transactionBuilder";
import { KeeperErrorCode } from "../src/errors";

const ownerKp = Keypair.random();
const verifierKp = Keypair.random();
const dummyContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const networkPassphrase = Networks.TESTNET;

function createMockServer(simResponseOverride?: any) {
  const server = {
    getAccount: async (publicKey: string) => {
      return new Account(publicKey, "100");
    },
    simulateTransaction: async (tx: any) => {
      if (simResponseOverride) return simResponseOverride;
      return {
        id: "1",
        latestLedger: 100,
        transactionData: new SorobanDataBuilder().build().toXDR("base64"),
        minResourceFee: "100",
        results: [
          {
            auth: [],
            xdr: xdr.ScVal.scvVoid().toXDR("base64"),
          },
        ],
      };
    },
    sendTransaction: async (tx: any) => {
      return {
        status: "PENDING",
        hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      };
    },
    getTransaction: async (hash: string) => {
      return {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        returnValue: undefined,
      };
    },
  } as unknown as rpc.Server;

  return server;
}

test("updateVerifier signers extraction and transaction building", () => {
  const signers = getRequiredSigners("updateVerifier", { owner: ownerKp.publicKey() });
  assert.deepEqual(signers, [ownerKp.publicKey()]);
});

test("client.updateVerifier supports setting and clearing a verifier", async () => {
  const mockServer = createMockServer();
  const client = new KeeperRegistryClient({
    contractId: dummyContractId,
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase,
    secretKey: ownerKp.secret(),
  });
  (client as any).server = mockServer;

  // Setting a verifier
  const resSet = await client.updateVerifier({
    owner: ownerKp.publicKey(),
    taskId: 1n,
    verifier: verifierKp.publicKey(),
  });
  assert.equal(resSet.status, "SUCCESS");

  // Clearing a verifier (verifier: undefined)
  const resClear = await updateVerifier(client, {
    owner: ownerKp.publicKey(),
    taskId: 1n,
    verifier: undefined,
  });
  assert.equal(resClear.status, "SUCCESS");
});

test("updateVerifier rejects attempt against a claimed task with KeeperErrorCode.InvalidTaskStatus", async () => {
  const mockServer = createMockServer({
    id: "1",
    latestLedger: 100,
    minResourceFee: "100",
    error: "HostError: Error(Contract, #5)", // InvalidTaskStatus (5)
  });

  const client = new KeeperRegistryClient({
    contractId: dummyContractId,
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase,
  });
  (client as any).server = mockServer;

  const preview = await client.previewTransaction("updateVerifier", {
    owner: ownerKp.publicKey(),
    taskId: 1n,
    verifier: verifierKp.publicKey(),
  });

  assert.equal(preview.success, false);
  assert.equal(preview.errorCode, KeeperErrorCode.InvalidTaskStatus);
});
