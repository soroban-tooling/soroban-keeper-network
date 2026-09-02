"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const client_1 = require("../src/client");
const transactionBuilder_1 = require("../src/transactionBuilder");
const types_1 = require("../src/types");
const errors_1 = require("../src/errors");
const adminKp = stellar_sdk_1.Keypair.random();
const newAdminKp = stellar_sdk_1.Keypair.random();
const ownerKp = stellar_sdk_1.Keypair.random();
const keeperKp = stellar_sdk_1.Keypair.random();
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
(0, node_test_1.default)("getRequiredSigners extracts signers for all mutating methods", () => {
    // Dual-auth case
    const dualSigners = (0, transactionBuilder_1.getRequiredSigners)("transferAdmin", {
        admin: adminKp.publicKey(),
        newAdmin: newAdminKp.publicKey(),
    });
    strict_1.default.deepEqual(dualSigners, [adminKp.publicKey(), newAdminKp.publicKey()]);
    // Owner methods
    const regSigners = (0, transactionBuilder_1.getRequiredSigners)("registerTask", { owner: ownerKp.publicKey() });
    strict_1.default.deepEqual(regSigners, [ownerKp.publicKey()]);
    const batchSigners = (0, transactionBuilder_1.getRequiredSigners)("batchRegisterTasks", { owner: ownerKp.publicKey() });
    strict_1.default.deepEqual(batchSigners, [ownerKp.publicKey()]);
    const increaseSigners = (0, transactionBuilder_1.getRequiredSigners)("increaseReward", { owner: ownerKp.publicKey() });
    strict_1.default.deepEqual(increaseSigners, [ownerKp.publicKey()]);
    const extendSigners = (0, transactionBuilder_1.getRequiredSigners)("extendDeadline", { owner: ownerKp.publicKey() });
    strict_1.default.deepEqual(extendSigners, [ownerKp.publicKey()]);
    const cancelSigners = (0, transactionBuilder_1.getRequiredSigners)("cancelTask", { owner: ownerKp.publicKey() });
    strict_1.default.deepEqual(cancelSigners, [ownerKp.publicKey()]);
    // Keeper methods
    const claimSigners = (0, transactionBuilder_1.getRequiredSigners)("claimTask", { keeper: keeperKp.publicKey() });
    strict_1.default.deepEqual(claimSigners, [keeperKp.publicKey()]);
    const execSigners = (0, transactionBuilder_1.getRequiredSigners)("executeTask", { keeper: keeperKp.publicKey() });
    strict_1.default.deepEqual(execSigners, [keeperKp.publicKey()]);
    const withdrawSigners = (0, transactionBuilder_1.getRequiredSigners)("withdrawRewards", { keeper: keeperKp.publicKey() });
    strict_1.default.deepEqual(withdrawSigners, [keeperKp.publicKey()]);
    // Admin methods
    const pauseSigners = (0, transactionBuilder_1.getRequiredSigners)("pause", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(pauseSigners, [adminKp.publicKey()]);
    const unpauseSigners = (0, transactionBuilder_1.getRequiredSigners)("unpause", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(unpauseSigners, [adminKp.publicKey()]);
    const feeSigners = (0, transactionBuilder_1.getRequiredSigners)("setFeeBps", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(feeSigners, [adminKp.publicKey()]);
    const minRewardSigners = (0, transactionBuilder_1.getRequiredSigners)("setMinReward", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(minRewardSigners, [adminKp.publicKey()]);
    const upgradeSigners = (0, transactionBuilder_1.getRequiredSigners)("upgrade", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(upgradeSigners, [adminKp.publicKey()]);
    const sweepSigners = (0, transactionBuilder_1.getRequiredSigners)("sweepFees", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(sweepSigners, [adminKp.publicKey()]);
    const initSigners = (0, transactionBuilder_1.getRequiredSigners)("initialize", { admin: adminKp.publicKey() });
    strict_1.default.deepEqual(initSigners, [adminKp.publicKey()]);
});
(0, node_test_1.default)("buildTransaction constructs unsigned XDR for single and dual-auth operations", async () => {
    const mockServer = createMockServer();
    // Test single-auth registerTask
    const regBuilt = await (0, transactionBuilder_1.buildTransaction)(mockServer, dummyContractId, networkPassphrase, "registerTask", {
        owner: ownerKp.publicKey(),
        taskType: types_1.TaskType.Liquidation,
        calldata: Buffer.from("test-calldata"),
        reward: 10000000n,
        deadline: 1700000000n,
        ttlLedgers: 100,
        lockLedgers: 20,
    });
    strict_1.default.ok(regBuilt.unsignedXdr.length > 0);
    strict_1.default.deepEqual(regBuilt.signers, [ownerKp.publicKey()]);
    // Test dual-auth transferAdmin
    const dualBuilt = await (0, transactionBuilder_1.buildTransaction)(mockServer, dummyContractId, networkPassphrase, "transferAdmin", {
        admin: adminKp.publicKey(),
        newAdmin: newAdminKp.publicKey(),
    });
    strict_1.default.ok(dualBuilt.unsignedXdr.length > 0);
    strict_1.default.deepEqual(dualBuilt.signers, [adminKp.publicKey(), newAdminKp.publicKey()]);
});
(0, node_test_1.default)("simulates full unsigned-build, external-sign (wallet stand-in), submit round trip", async () => {
    const mockServer = createMockServer();
    const client = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
    });
    // Inject mock server
    client.server = mockServer;
    // Step 1: Build unsigned transaction (as a browser dApp would)
    const { unsignedXdr, signers } = await client.buildTransaction("transferAdmin", {
        admin: adminKp.publicKey(),
        newAdmin: newAdminKp.publicKey(),
    });
    strict_1.default.deepEqual(signers, [adminKp.publicKey(), newAdminKp.publicKey()]);
    // Step 2: External signing flow (simulating two wallets signing the unsigned XDR)
    const tx = stellar_sdk_1.TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
    tx.sign(adminKp);
    tx.sign(newAdminKp);
    const signedXdr = tx.toXDR();
    // Step 3: Submit signed transaction
    const result = await client.submitSignedTransaction(signedXdr);
    strict_1.default.equal(result.status, "SUCCESS");
    strict_1.default.ok(result.hash.length > 0);
});
(0, node_test_1.default)("previewTransaction succeeds without any signer present and extracts resource costs", async () => {
    const mockSorobanData = new stellar_sdk_1.SorobanDataBuilder().setResources(500, 100, 200).build();
    const mockServer = createMockServer({
        id: "1",
        latestLedger: 100,
        transactionData: mockSorobanData.toXDR("base64"),
        minResourceFee: "1500",
        results: [
            {
                auth: [],
                xdr: stellar_sdk_1.xdr.ScVal.scvU64(new stellar_sdk_1.xdr.Uint64(42n)).toXDR("base64"),
            },
        ],
    });
    const client = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
    });
    client.server = mockServer;
    // Preview call without sourcePublicKey or signer passed
    const preview = await client.previewTransaction("claimTask", {
        keeper: keeperKp.publicKey(),
        taskId: 1n,
    });
    strict_1.default.equal(preview.success, true);
    strict_1.default.equal(preview.returnValue, 42n);
    strict_1.default.equal(preview.resourceCost.minResourceFee, 1500n);
    strict_1.default.equal(preview.resourceCost.cpuInstructions, 500);
});
(0, node_test_1.default)("previewTransaction handles failed simulation and surfaces typed KeeperErrorCode", async () => {
    const mockServer = createMockServer({
        id: "1",
        latestLedger: 100,
        minResourceFee: "100",
        error: "HostError: Error(Contract, #4)", // TaskNotFound (4)
    });
    const client = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
    });
    client.server = mockServer;
    const preview = await client.previewTransaction("claimTask", {
        keeper: keeperKp.publicKey(),
        taskId: 999n,
    });
    strict_1.default.equal(preview.success, false);
    strict_1.default.equal(preview.error, "HostError: Error(Contract, #4)");
    strict_1.default.equal(preview.errorCode, errors_1.KeeperErrorCode.TaskNotFound);
});
(0, node_test_1.default)("KeeperRegistryClient validates inputs and client-side error checks", async () => {
    const client = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
    });
    // Invalid contract ID in constructor
    strict_1.default.throws(() => new client_1.KeeperRegistryClient({
        contractId: "invalid-contract-id",
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase,
    }), /Invalid contract ID/);
    // Client-side negative reward check for registerTask
    await strict_1.default.rejects(async () => {
        await client.registerTask({
            owner: ownerKp.publicKey(),
            taskType: types_1.TaskType.Liquidation,
            calldata: Buffer.from(""),
            reward: -100n,
            deadline: 100n,
            ttlLedgers: 10,
            lockLedgers: 10,
        });
    }, /Task reward must be greater than zero/);
});
//# sourceMappingURL=transactionBuilder.test.js.map