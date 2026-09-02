"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const client_1 = require("../src/client");
const updateVerifier_1 = require("../src/methods/updateVerifier");
const transactionBuilder_1 = require("../src/transactionBuilder");
const errors_1 = require("../src/errors");
const ownerKp = stellar_sdk_1.Keypair.random();
const verifierKp = stellar_sdk_1.Keypair.random();
const dummyContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const networkPassphrase = stellar_sdk_1.Networks.TESTNET;
function createMockServer(simResponseOverride) {
    const server = {
        getAccount: async (publicKey) => {
            return new stellar_sdk_1.Account(publicKey, "100");
        },
        simulateTransaction: async (tx) => {
            if (simResponseOverride)
                return simResponseOverride;
            return {
                id: "1",
                latestLedger: 100,
                transactionData: new stellar_sdk_1.SorobanDataBuilder().build().toXDR("base64"),
                minResourceFee: "100",
                results: [
                    {
                        auth: [],
                        xdr: stellar_sdk_1.xdr.ScVal.scvVoid().toXDR("base64"),
                    },
                ],
            };
        },
        sendTransaction: async (tx) => {
            return {
                status: "PENDING",
                hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            };
        },
        getTransaction: async (hash) => {
            return {
                status: stellar_sdk_1.rpc.Api.GetTransactionStatus.SUCCESS,
                returnValue: undefined,
            };
        },
    };
    return server;
}
(0, node_test_1.default)("updateVerifier signers extraction and transaction building", () => {
    const signers = (0, transactionBuilder_1.getRequiredSigners)("updateVerifier", { owner: ownerKp.publicKey() });
    strict_1.default.deepEqual(signers, [ownerKp.publicKey()]);
});
(0, node_test_1.default)("client.updateVerifier supports setting and clearing a verifier", async () => {
    const mockServer = createMockServer();
    const client = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
        secretKey: ownerKp.secret(),
    });
    client.server = mockServer;
    // Setting a verifier
    const resSet = await client.updateVerifier({
        owner: ownerKp.publicKey(),
        taskId: 1n,
        verifier: verifierKp.publicKey(),
    });
    strict_1.default.equal(resSet.status, "SUCCESS");
    // Clearing a verifier (verifier: undefined)
    const resClear = await (0, updateVerifier_1.updateVerifier)(client, {
        owner: ownerKp.publicKey(),
        taskId: 1n,
        verifier: undefined,
    });
    strict_1.default.equal(resClear.status, "SUCCESS");
});
(0, node_test_1.default)("updateVerifier rejects attempt against a claimed task with KeeperErrorCode.InvalidTaskStatus", async () => {
    const mockServer = createMockServer({
        id: "1",
        latestLedger: 100,
        minResourceFee: "100",
        error: "HostError: Error(Contract, #5)", // InvalidTaskStatus (5)
    });
    const client = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
    });
    client.server = mockServer;
    const preview = await client.previewTransaction("updateVerifier", {
        owner: ownerKp.publicKey(),
        taskId: 1n,
        verifier: verifierKp.publicKey(),
    });
    strict_1.default.equal(preview.success, false);
    strict_1.default.equal(preview.errorCode, errors_1.KeeperErrorCode.InvalidTaskStatus);
});
//# sourceMappingURL=updateVerifier.test.js.map