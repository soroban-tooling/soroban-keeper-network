"use strict";
/**
 * Soroban Keeper Network — TypeScript SDK Types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskStatus = exports.TaskType = void 0;
var TaskType;
(function (TaskType) {
    TaskType[TaskType["Liquidation"] = 0] = "Liquidation";
    TaskType[TaskType["OraclePricePush"] = 1] = "OraclePricePush";
    TaskType[TaskType["FundingRateUpdate"] = 2] = "FundingRateUpdate";
    TaskType[TaskType["LiquidityRebalance"] = 3] = "LiquidityRebalance";
    TaskType[TaskType["TtlExtension"] = 4] = "TtlExtension";
    TaskType[TaskType["Custom"] = 5] = "Custom";
})(TaskType || (exports.TaskType = TaskType = {}));
var TaskStatus;
(function (TaskStatus) {
    TaskStatus[TaskStatus["Pending"] = 0] = "Pending";
    TaskStatus[TaskStatus["Claimed"] = 1] = "Claimed";
    TaskStatus[TaskStatus["Executed"] = 2] = "Executed";
    TaskStatus[TaskStatus["Expired"] = 3] = "Expired";
    TaskStatus[TaskStatus["Cancelled"] = 4] = "Cancelled";
})(TaskStatus || (exports.TaskStatus = TaskStatus = {}));
//# sourceMappingURL=types.js.map