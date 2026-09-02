"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMethodName = normalizeMethodName;
exports.getRequiredSigners = getRequiredSigners;
exports.encodeMethodArgs = encodeMethodArgs;
exports.extractResourceCost = extractResourceCost;
exports.buildTransaction = buildTransaction;
exports.previewTransaction = previewTransaction;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const utils_1 = require("./utils");
const errors_1 = require("./errors");
const DUMMY_SOURCE_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
/**
 * Normalizes camelCase method names to contract snake_case function names.
 */
function normalizeMethodName(methodName) {
    const mapping = {
        registerTask: "register_task",
        batchRegisterTasks: "batch_register_tasks",
        increaseReward: "increase_reward",
        extendDeadline: "extend_deadline",
        claimTask: "claim_task",
        executeTask: "execute_task",
        cancelTask: "cancel_task",
        expireTask: "expire_task",
        withdrawRewards: "withdraw_rewards",
        pause: "pause",
        unpause: "unpause",
        setFeeBps: "set_fee_bps",
        setMinReward: "set_min_reward",
        transferAdmin: "transfer_admin",
        upgrade: "upgrade",
        sweepFees: "sweep_fees",
        updateVerifier: "update_verifier",
        initialize: "initialize",
    };
    return mapping[methodName] || methodName;
}
/**
 * Determines which accounts must sign the transaction based on the contract method and parameters.
 */
function getRequiredSigners(methodName, params) {
    const normalized = normalizeMethodName(methodName);
    const signers = [];
    switch (normalized) {
        case "transfer_admin":
            if (params.admin)
                signers.push(params.admin);
            if (params.newAdmin || params.new_admin)
                signers.push(params.newAdmin || params.new_admin);
            break;
        case "register_task":
        case "batch_register_tasks":
        case "increase_reward":
        case "extend_deadline":
        case "cancel_task":
        case "update_verifier":
            if (params.owner)
                signers.push(params.owner);
            break;
        case "claim_task":
        case "execute_task":
        case "withdraw_rewards":
            if (params.keeper)
                signers.push(params.keeper);
            break;
        case "pause":
        case "unpause":
        case "set_fee_bps":
        case "set_min_reward":
        case "upgrade":
        case "sweep_fees":
        case "initialize":
            if (params.admin)
                signers.push(params.admin);
            break;
        case "expire_task":
            if (params.sourcePublicKey)
                signers.push(params.sourcePublicKey);
            break;
        default:
            if (params.admin)
                signers.push(params.admin);
            else if (params.owner)
                signers.push(params.owner);
            else if (params.keeper)
                signers.push(params.keeper);
            break;
    }
    // Deduplicate and filter empty values
    return Array.from(new Set(signers.filter((s) => typeof s === "string" && s.length > 0)));
}
/**
 * Encodes method parameters into an ordered array of Soroban ScVal contract arguments.
 */
function encodeMethodArgs(methodName, params) {
    const normalized = normalizeMethodName(methodName);
    switch (normalized) {
        case "initialize":
            return [
                (0, utils_1.encodeScVal)(params.admin, "address"),
                (0, utils_1.encodeScVal)(params.rewardToken || params.reward_token, "address"),
                (0, utils_1.encodeScVal)(params.feeBps ?? params.fee_bps, "u32"),
            ];
        case "register_task":
            return [
                (0, utils_1.encodeScVal)(params.owner, "address"),
                (0, utils_1.encodeScVal)(params.taskType ?? params.task_type, "u32"),
                (0, utils_1.encodeScVal)(params.calldata, "bytes"),
                (0, utils_1.encodeScVal)(params.reward, "i128"),
                (0, utils_1.encodeScVal)(params.deadline, "u64"),
                (0, utils_1.encodeScVal)(params.ttlLedgers ?? params.ttl_ledgers, "u32"),
                (0, utils_1.encodeScVal)(params.lockLedgers ?? params.lock_ledgers, "u32"),
                (0, utils_1.encodeScVal)(params.verifier, "opt_address"),
            ];
        case "batch_register_tasks": {
            const rawTasks = params.tasks || [];
            const encodedTasks = rawTasks.map((t) => {
                const mapEntries = [
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("calldata", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.calldata, "bytes"),
                    }),
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("deadline", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.deadline, "u64"),
                    }),
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("lock_ledgers", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.lockLedgers ?? t.lock_ledgers, "u32"),
                    }),
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("reward", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.reward, "i128"),
                    }),
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("task_type", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.taskType ?? t.task_type, "u32"),
                    }),
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("ttl_ledgers", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.ttlLedgers ?? t.ttl_ledgers, "u32"),
                    }),
                    new stellar_sdk_1.xdr.ScMapEntry({
                        key: (0, stellar_sdk_1.nativeToScVal)("verifier", { type: "symbol" }),
                        val: (0, utils_1.encodeScVal)(t.verifier, "opt_address"),
                    }),
                ];
                return stellar_sdk_1.xdr.ScVal.scvMap(mapEntries);
            });
            return [
                (0, utils_1.encodeScVal)(params.owner, "address"),
                stellar_sdk_1.xdr.ScVal.scvVec(encodedTasks),
                (0, utils_1.encodeScVal)(params.maxTotalReward ?? params.max_total_reward, "i128"),
            ];
        }
        case "increase_reward":
            return [
                (0, utils_1.encodeScVal)(params.owner, "address"),
                (0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64"),
                (0, utils_1.encodeScVal)(params.additional, "i128"),
            ];
        case "extend_deadline":
            return [
                (0, utils_1.encodeScVal)(params.owner, "address"),
                (0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64"),
                (0, utils_1.encodeScVal)(params.additionalLedgers ?? params.additional_ledgers, "u64"),
            ];
        case "claim_task":
            return [
                (0, utils_1.encodeScVal)(params.keeper, "address"),
                (0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64"),
            ];
        case "execute_task":
            return [
                (0, utils_1.encodeScVal)(params.keeper, "address"),
                (0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64"),
                (0, utils_1.encodeScVal)(params.proof, "bytes"),
            ];
        case "cancel_task":
            return [
                (0, utils_1.encodeScVal)(params.owner, "address"),
                (0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64"),
            ];
        case "expire_task":
            return [(0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64")];
        case "withdraw_rewards":
            return [(0, utils_1.encodeScVal)(params.keeper, "address")];
        case "pause":
        case "unpause":
            return [(0, utils_1.encodeScVal)(params.admin, "address")];
        case "set_fee_bps":
            return [
                (0, utils_1.encodeScVal)(params.admin, "address"),
                (0, utils_1.encodeScVal)(params.newBps ?? params.new_bps, "u32"),
            ];
        case "set_min_reward":
            return [
                (0, utils_1.encodeScVal)(params.admin, "address"),
                (0, utils_1.encodeScVal)(params.minReward ?? params.min_reward, "i128"),
            ];
        case "transfer_admin":
            return [
                (0, utils_1.encodeScVal)(params.admin, "address"),
                (0, utils_1.encodeScVal)(params.newAdmin ?? params.new_admin, "address"),
            ];
        case "upgrade":
            return [
                (0, utils_1.encodeScVal)(params.admin, "address"),
                (0, utils_1.encodeScVal)(params.newWasmHash ?? params.new_wasm_hash, "bytes32"),
            ];
        case "sweep_fees":
            return [
                (0, utils_1.encodeScVal)(params.admin, "address"),
                (0, utils_1.encodeScVal)(params.treasury, "address"),
                (0, utils_1.encodeScVal)(params.amount, "i128"),
            ];
        case "update_verifier":
            return [
                (0, utils_1.encodeScVal)(params.owner, "address"),
                (0, utils_1.encodeScVal)(params.taskId ?? params.task_id, "u64"),
                (0, utils_1.encodeScVal)(params.verifier, "opt_address"),
            ];
        default:
            throw new Error(`Unsupported or unknown contract method: "${methodName}".`);
    }
}
/**
 * Extracts resource cost metrics (minResourceFee, cpuInstructions, memoryBytes) from simulation response.
 */
function extractResourceCost(simResponse) {
    let minResourceFee = 0n;
    if (simResponse?.minResourceFee) {
        minResourceFee = BigInt(simResponse.minResourceFee);
    }
    let cpuInstructions;
    let memoryBytes;
    try {
        let txData = simResponse?.transactionData;
        if (typeof txData === "string") {
            txData = stellar_sdk_1.xdr.SorobanTransactionData.fromXDR(txData, "base64");
        }
        if (txData && typeof txData.resources === "function") {
            const res = txData.resources();
            if (res) {
                if (typeof res.instructions === "function") {
                    cpuInstructions = Number(res.instructions());
                }
                const readB = typeof res.readBytes === "function" ? Number(res.readBytes()) : 0;
                const writeB = typeof res.writeBytes === "function" ? Number(res.writeBytes()) : 0;
                if (readB || writeB) {
                    memoryBytes = readB + writeB;
                }
            }
        }
    }
    catch {
        // If parsing resources fails, keep minResourceFee and undefined metrics
    }
    return {
        cpuInstructions,
        memoryBytes,
        minResourceFee,
    };
}
/**
 * Builds an unsigned Soroban transaction for any mutating contract method.
 */
async function buildTransaction(server, contractId, networkPassphrase, methodName, params, options = {}) {
    (0, utils_1.validateContractId)(contractId);
    const signers = getRequiredSigners(methodName, params);
    const sourcePublicKey = options.sourcePublicKey || signers[0] || params.sourcePublicKey;
    if (!sourcePublicKey) {
        throw new Error(`No source account public key provided for buildTransaction("${methodName}"). Pass sourcePublicKey in options or specify account parameters.`);
    }
    (0, utils_1.validateAddress)(sourcePublicKey, "sourcePublicKey");
    const snakeMethod = normalizeMethodName(methodName);
    const scArgs = encodeMethodArgs(methodName, params);
    const account = await server.getAccount(sourcePublicKey);
    const contract = new stellar_sdk_1.Contract(contractId);
    const fee = options.fee ? String(options.fee) : stellar_sdk_1.BASE_FEE;
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const rawTx = new stellar_sdk_1.TransactionBuilder(account, {
        fee,
        networkPassphrase,
    })
        .addOperation(contract.call(snakeMethod, ...scArgs))
        .setTimeout(timeoutSeconds)
        .build();
    const simResponse = await server.simulateTransaction(rawTx);
    if (stellar_sdk_1.rpc.Api.isSimulationError(simResponse)) {
        throw new Error(`Soroban simulation failed for ${methodName}: ${simResponse.error}`);
    }
    const assembledTx = stellar_sdk_1.rpc.assembleTransaction(rawTx, simResponse).build();
    return {
        unsignedXdr: assembledTx.toXDR(),
        signers,
    };
}
/**
 * Previews a transaction simulation without requiring any signers or private keys.
 * Returns estimated resource costs and expected return value (or decoded typed KeeperErrorCode if failed).
 */
async function previewTransaction(server, contractId, networkPassphrase, methodName, params, options = {}) {
    (0, utils_1.validateContractId)(contractId);
    const signers = getRequiredSigners(methodName, params);
    const sourcePublicKey = options.sourcePublicKey || signers[0] || params.sourcePublicKey || DUMMY_SOURCE_ACCOUNT;
    const snakeMethod = normalizeMethodName(methodName);
    const scArgs = encodeMethodArgs(methodName, params);
    const account = new stellar_sdk_1.Account(sourcePublicKey, "0");
    const contract = new stellar_sdk_1.Contract(contractId);
    const fee = options.fee ? String(options.fee) : stellar_sdk_1.BASE_FEE;
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const rawTx = new stellar_sdk_1.TransactionBuilder(account, {
        fee,
        networkPassphrase,
    })
        .addOperation(contract.call(snakeMethod, ...scArgs))
        .setTimeout(timeoutSeconds)
        .build();
    const simResponse = await server.simulateTransaction(rawTx);
    const resourceCost = extractResourceCost(simResponse);
    if (stellar_sdk_1.rpc.Api.isSimulationError(simResponse)) {
        const errorMsg = simResponse.error || "Simulation failed";
        const errorCode = (0, errors_1.decodeKeeperError)(errorMsg);
        return {
            success: false,
            error: errorMsg,
            errorCode,
            resourceCost,
            rawSimulation: simResponse,
        };
    }
    let returnValue = undefined;
    if (simResponse.result) {
        returnValue = simResponse.result.retval
            ? (0, stellar_sdk_1.scValToNative)(simResponse.result.retval)
            : undefined;
    }
    else if (Array.isArray(simResponse.results) && simResponse.results.length > 0) {
        const res = simResponse.results[0];
        if (res.xdr) {
            const scVal = stellar_sdk_1.xdr.ScVal.fromXDR(res.xdr, "base64");
            returnValue = (0, stellar_sdk_1.scValToNative)(scVal);
        }
    }
    return {
        success: true,
        returnValue,
        resourceCost,
        rawSimulation: simResponse,
    };
}
//# sourceMappingURL=transactionBuilder.js.map