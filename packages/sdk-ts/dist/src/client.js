"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeeperRegistryClient = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const utils_1 = require("./utils");
const transactionBuilder_1 = require("./transactionBuilder");
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
class KeeperRegistryClient {
    contractId;
    rpcUrl;
    networkPassphrase;
    server;
    secretKey;
    constructor(config) {
        (0, utils_1.validateContractId)(config.contractId);
        if (!config.rpcUrl) {
            throw new Error("RPC URL must be provided.");
        }
        if (!config.networkPassphrase) {
            throw new Error("Network passphrase must be provided.");
        }
        if (config.secretKey) {
            (0, utils_1.validateSecretKey)(config.secretKey);
            this.secretKey = config.secretKey;
        }
        this.contractId = config.contractId;
        this.rpcUrl = config.rpcUrl;
        this.networkPassphrase = config.networkPassphrase;
        this.server = new stellar_sdk_1.rpc.Server(config.rpcUrl, { allowHttp: false });
    }
    /**
     * Lower-level method: Builds an unsigned transaction XDR plus required signers metadata.
     *
     * Recommended for browser dApps integrating with wallet extensions (Freighter, Wallet-Kit).
     *
     * @param methodName Method name to invoke (e.g. "registerTask", "transferAdmin")
     * @param params Method parameters
     * @param options Building options (sourcePublicKey, fee, timeoutSeconds)
     */
    async buildTransaction(methodName, params, options) {
        return (0, transactionBuilder_1.buildTransaction)(this.server, this.contractId, this.networkPassphrase, methodName, params, options);
    }
    /**
     * Lower-level method: Previews a transaction simulation before submission without requiring any signers or private keys.
     * Returns resource costs (minResourceFee, cpuInstructions, memoryBytes) and simulated return value (or decoded typed KeeperErrorCode).
     *
     * @param methodName Method name to preview (e.g. "registerTask", "claimTask")
     * @param params Method parameters
     * @param options Preview options (sourcePublicKey, fee, timeoutSeconds)
     */
    async previewTransaction(methodName, params, options) {
        return (0, transactionBuilder_1.previewTransaction)(this.server, this.contractId, this.networkPassphrase, methodName, params, options);
    }
    /**
     * Lower-level method: Submits a signed transaction XDR base64 string to the Soroban RPC server
     * and polls until confirmation.
     *
     * @param signedXdr The signed transaction XDR base64 string
     */
    async submitSignedTransaction(signedXdr) {
        const tx = stellar_sdk_1.TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
        const sendResponse = await this.server.sendTransaction(tx);
        if (sendResponse.status === "ERROR") {
            throw new Error(`Transaction submission failed: ${JSON.stringify(sendResponse.errorResult)}`);
        }
        const hash = sendResponse.hash;
        let attempts = 0;
        let getResponse = await this.server.getTransaction(hash);
        while (getResponse.status === stellar_sdk_1.rpc.Api.GetTransactionStatus.NOT_FOUND &&
            attempts < 30) {
            await sleep(1000);
            getResponse = await this.server.getTransaction(hash);
            attempts++;
        }
        if (getResponse.status === stellar_sdk_1.rpc.Api.GetTransactionStatus.SUCCESS) {
            return {
                hash,
                status: "SUCCESS",
                returnValue: getResponse.returnValue ? (0, stellar_sdk_1.scValToNative)(getResponse.returnValue) : undefined,
                rawResponse: getResponse,
            };
        }
        else {
            throw new Error(`Transaction failed on-chain with status: ${getResponse.status}`);
        }
    }
    /**
     * Helper to execute convenience server-side signing for mutating methods.
     */
    async executeWithSecretKey(methodName, params, options) {
        if (!this.secretKey && (!options?.additionalSecretKeys || options.additionalSecretKeys.length === 0)) {
            throw new Error(`Convenience method "${methodName}" requires a configured secretKey in KeeperRegistryClient or options. ` +
                `For wallet extension flows, use client.buildTransaction("${methodName}", params) -> wallet.sign() -> client.submitSignedTransaction(signedXdr).`);
        }
        const mainKeypair = this.secretKey ? stellar_sdk_1.Keypair.fromSecret(this.secretKey) : undefined;
        const sourcePublicKey = options?.sourcePublicKey || mainKeypair?.publicKey();
        const built = await this.buildTransaction(methodName, params, {
            ...options,
            sourcePublicKey,
        });
        const tx = stellar_sdk_1.TransactionBuilder.fromXDR(built.unsignedXdr, this.networkPassphrase);
        if (mainKeypair) {
            tx.sign(mainKeypair);
        }
        if (options?.additionalSecretKeys) {
            for (const secret of options.additionalSecretKeys) {
                tx.sign(stellar_sdk_1.Keypair.fromSecret(secret));
            }
        }
        return this.submitSignedTransaction(tx.toXDR());
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Mutating Convenience Wrappers
    // ─────────────────────────────────────────────────────────────────────────────
    async registerTask(params, options) {
        if (BigInt(params.reward) <= 0n) {
            throw new Error("Task reward must be greater than zero.");
        }
        return this.executeWithSecretKey("registerTask", params, options);
    }
    async batchRegisterTasks(params, options) {
        if (params.tasks.length === 0) {
            throw new Error("Batch tasks list cannot be empty.");
        }
        return this.executeWithSecretKey("batchRegisterTasks", params, options);
    }
    async increaseReward(params, options) {
        if (BigInt(params.additional) <= 0n) {
            throw new Error("Additional reward must be greater than zero.");
        }
        return this.executeWithSecretKey("increaseReward", params, options);
    }
    async extendDeadline(params, options) {
        return this.executeWithSecretKey("extendDeadline", params, options);
    }
    async claimTask(params, options) {
        return this.executeWithSecretKey("claimTask", params, options);
    }
    async executeTask(params, options) {
        return this.executeWithSecretKey("executeTask", params, options);
    }
    async cancelTask(params, options) {
        return this.executeWithSecretKey("cancelTask", params, options);
    }
    async expireTask(params, options) {
        return this.executeWithSecretKey("expireTask", params, options);
    }
    async withdrawRewards(params, options) {
        return this.executeWithSecretKey("withdrawRewards", params, options);
    }
    async pause(params, options) {
        return this.executeWithSecretKey("pause", params, options);
    }
    async unpause(params, options) {
        return this.executeWithSecretKey("unpause", params, options);
    }
    async setFeeBps(params, options) {
        return this.executeWithSecretKey("setFeeBps", params, options);
    }
    async setMinReward(params, options) {
        return this.executeWithSecretKey("setMinReward", params, options);
    }
    /**
     * Dual-auth admin transfer: requires signatures from both `admin` and `newAdmin`.
     * Pass both secret keys in options.additionalSecretKeys for server-side keypair calls,
     * or use `buildTransaction("transferAdmin", { admin, newAdmin })` for wallet flows.
     */
    async transferAdmin(params, options) {
        const additionalSecretKeys = [];
        if (options?.newAdminSecretKey) {
            additionalSecretKeys.push(options.newAdminSecretKey);
        }
        return this.executeWithSecretKey("transferAdmin", params, {
            ...options,
            additionalSecretKeys,
        });
    }
    async upgrade(params, options) {
        return this.executeWithSecretKey("upgrade", params, options);
    }
    async sweepFees(params, options) {
        if (BigInt(params.amount) <= 0n) {
            throw new Error("Sweep fee amount must be greater than zero.");
        }
        return this.executeWithSecretKey("sweepFees", params, options);
    }
    async updateVerifier(params, options) {
        return this.executeWithSecretKey("updateVerifier", params, options);
    }
    async initialize(params, options) {
        return this.executeWithSecretKey("initialize", params, options);
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Read-Only Views (Simulation-based)
    // ─────────────────────────────────────────────────────────────────────────────
    async readContract(methodName, args, sourcePublicKey) {
        const key = sourcePublicKey || (this.secretKey ? stellar_sdk_1.Keypair.fromSecret(this.secretKey).publicKey() : undefined);
        if (!key) {
            throw new Error(`sourcePublicKey is required for readContract("${methodName}") simulation when no secretKey is set.`);
        }
        const snakeMethod = (0, transactionBuilder_1.normalizeMethodName)(methodName);
        const account = await this.server.getAccount(key);
        const contract = new stellar_sdk_1.Contract(this.contractId);
        const tx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(contract.call(snakeMethod, ...args))
            .setTimeout(30)
            .build();
        const sim = await this.server.simulateTransaction(tx);
        if (stellar_sdk_1.rpc.Api.isSimulationError(sim)) {
            throw new Error(`Simulation failed for ${methodName}: ${sim.error}`);
        }
        return sim.result ? (0, stellar_sdk_1.scValToNative)(sim.result.retval) : null;
    }
    async getTask(taskId, sourcePublicKey) {
        const raw = await this.readContract("get_task", [(0, utils_1.encodeScVal)(taskId, "u64")], sourcePublicKey);
        if (!raw)
            return null;
        return {
            id: BigInt(raw.id),
            owner: raw.owner,
            taskType: Number(raw.task_type),
            calldata: Buffer.from(raw.calldata),
            reward: BigInt(raw.reward),
            deadline: BigInt(raw.deadline),
            ttlLedgers: Number(raw.ttl_ledgers),
            lockLedgers: Number(raw.lock_ledgers),
            verifier: raw.verifier || undefined,
            status: Number(raw.status),
            claimedBy: raw.claimed_by || undefined,
            claimDeadline: raw.claim_deadline ? BigInt(raw.claim_deadline) : undefined,
        };
    }
    async taskCount(sourcePublicKey) {
        const raw = await this.readContract("task_count", [], sourcePublicKey);
        return BigInt(raw || 0);
    }
    async keeperBalance(keeper, sourcePublicKey) {
        (0, utils_1.validateAddress)(keeper, "keeper");
        const raw = await this.readContract("keeper_balance", [(0, utils_1.encodeScVal)(keeper, "address")], sourcePublicKey);
        return BigInt(raw || 0);
    }
    async feesAccrued(sourcePublicKey) {
        const raw = await this.readContract("fees_accrued", [], sourcePublicKey);
        return BigInt(raw || 0);
    }
    async isPaused(sourcePublicKey) {
        const raw = await this.readContract("is_paused", [], sourcePublicKey);
        return Boolean(raw);
    }
    async admin(sourcePublicKey) {
        return await this.readContract("admin", [], sourcePublicKey);
    }
    async getFeeBps(sourcePublicKey) {
        const raw = await this.readContract("get_fee_bps", [], sourcePublicKey);
        return Number(raw || 0);
    }
    async rewardTokenAddress(sourcePublicKey) {
        return await this.readContract("reward_token_address", [], sourcePublicKey);
    }
}
exports.KeeperRegistryClient = KeeperRegistryClient;
//# sourceMappingURL=client.js.map