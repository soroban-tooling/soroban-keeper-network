"use strict";
/**
 * Soroban Keeper Network — Typed Error Decoding
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeeperErrorCode = void 0;
exports.decodeKeeperError = decodeKeeperError;
/**
 * TypeScript enum mirroring the contract's KeeperError discriminants in `contracts/keeper-registry/src/errors.rs`.
 */
var KeeperErrorCode;
(function (KeeperErrorCode) {
    KeeperErrorCode[KeeperErrorCode["AlreadyInitialized"] = 1] = "AlreadyInitialized";
    KeeperErrorCode[KeeperErrorCode["Unauthorized"] = 2] = "Unauthorized";
    KeeperErrorCode[KeeperErrorCode["ContractPaused"] = 3] = "ContractPaused";
    KeeperErrorCode[KeeperErrorCode["TaskNotFound"] = 4] = "TaskNotFound";
    KeeperErrorCode[KeeperErrorCode["InvalidTaskStatus"] = 5] = "InvalidTaskStatus";
    KeeperErrorCode[KeeperErrorCode["DeadlinePassed"] = 6] = "DeadlinePassed";
    KeeperErrorCode[KeeperErrorCode["DeadlineNotPassed"] = 7] = "DeadlineNotPassed";
    KeeperErrorCode[KeeperErrorCode["InvalidReward"] = 8] = "InvalidReward";
    KeeperErrorCode[KeeperErrorCode["LockPeriodActive"] = 9] = "LockPeriodActive";
    KeeperErrorCode[KeeperErrorCode["InvalidFeeBps"] = 10] = "InvalidFeeBps";
    KeeperErrorCode[KeeperErrorCode["NotTaskOwner"] = 11] = "NotTaskOwner";
    KeeperErrorCode[KeeperErrorCode["NotTaskClaimer"] = 12] = "NotTaskClaimer";
    KeeperErrorCode[KeeperErrorCode["NoRewardsAvailable"] = 13] = "NoRewardsAvailable";
    KeeperErrorCode[KeeperErrorCode["ProofTooLarge"] = 14] = "ProofTooLarge";
    KeeperErrorCode[KeeperErrorCode["NotInitialized"] = 15] = "NotInitialized";
    KeeperErrorCode[KeeperErrorCode["TtlTooShort"] = 16] = "TtlTooShort";
    KeeperErrorCode[KeeperErrorCode["CalldataTooLarge"] = 17] = "CalldataTooLarge";
    KeeperErrorCode[KeeperErrorCode["InvalidTaskParams"] = 18] = "InvalidTaskParams";
    KeeperErrorCode[KeeperErrorCode["ArithmeticOverflow"] = 19] = "ArithmeticOverflow";
    KeeperErrorCode[KeeperErrorCode["IncompatibleVerifierInterface"] = 20] = "IncompatibleVerifierInterface";
    KeeperErrorCode[KeeperErrorCode["BatchTooLarge"] = 21] = "BatchTooLarge";
    KeeperErrorCode[KeeperErrorCode["EmptyBatch"] = 22] = "EmptyBatch";
    KeeperErrorCode[KeeperErrorCode["BatchRewardCeilingExceeded"] = 23] = "BatchRewardCeilingExceeded";
})(KeeperErrorCode || (exports.KeeperErrorCode = KeeperErrorCode = {}));
/**
 * Decodes a simulation error message or response into a typed `KeeperErrorCode`.
 * Returns `undefined` if the error was a host-level or network-level error rather than a contract `KeeperError`.
 *
 * @param error The raw error string, Error object, or simulation error response
 */
function decodeKeeperError(error) {
    if (!error)
        return undefined;
    let errorStr = "";
    if (typeof error === "string") {
        errorStr = error;
    }
    else if (typeof error === "object") {
        errorStr = error.message || error.error || error.errorResult || JSON.stringify(error);
    }
    if (typeof errorStr !== "string")
        return undefined;
    // Matches patterns such as "Error(Contract, #4)", "ContractError(4)", "Error(Contract, #0x04)", "HostError: Error(Contract, #4)"
    const match = errorStr.match(/Error\(Contract,\s*#?(\d+)\)/i) ||
        errorStr.match(/ContractError\((\d+)\)/i) ||
        errorStr.match(/Error\(Contract,\s*#0x([0-9a-f]+)\)/i);
    if (match) {
        const rawCode = match[1];
        const code = match[0].toLowerCase().includes("#0x") || rawCode.startsWith("0x")
            ? parseInt(rawCode, 16)
            : parseInt(rawCode, 10);
        if (code in KeeperErrorCode && typeof KeeperErrorCode[code] === "string") {
            return code;
        }
    }
    return undefined;
}
//# sourceMappingURL=errors.js.map