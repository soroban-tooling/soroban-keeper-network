"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const errors_1 = require("../src/errors");
(0, node_test_1.default)("decodeKeeperError decodes contract error strings accurately", () => {
    strict_1.default.equal((0, errors_1.decodeKeeperError)("HostError: Error(Contract, #4)"), errors_1.KeeperErrorCode.TaskNotFound);
    strict_1.default.equal((0, errors_1.decodeKeeperError)("Error(Contract, #1)"), errors_1.KeeperErrorCode.AlreadyInitialized);
    strict_1.default.equal((0, errors_1.decodeKeeperError)("ContractError(23)"), errors_1.KeeperErrorCode.BatchRewardCeilingExceeded);
    strict_1.default.equal((0, errors_1.decodeKeeperError)("Error(Contract, #0x17)"), errors_1.KeeperErrorCode.BatchRewardCeilingExceeded);
    // Object error structure
    strict_1.default.equal((0, errors_1.decodeKeeperError)({ error: "Error(Contract, #15)" }), errors_1.KeeperErrorCode.NotInitialized);
    strict_1.default.equal((0, errors_1.decodeKeeperError)(new Error("HostError: Error(Contract, #3)")), errors_1.KeeperErrorCode.ContractPaused);
});
(0, node_test_1.default)("decodeKeeperError returns undefined for non-contract errors", () => {
    strict_1.default.equal((0, errors_1.decodeKeeperError)("Network timeout"), undefined);
    strict_1.default.equal((0, errors_1.decodeKeeperError)("Transaction expired"), undefined);
    strict_1.default.equal((0, errors_1.decodeKeeperError)(new Error("RPC node unreachable")), undefined);
    strict_1.default.equal((0, errors_1.decodeKeeperError)(null), undefined);
    strict_1.default.equal((0, errors_1.decodeKeeperError)(undefined), undefined);
    strict_1.default.equal((0, errors_1.decodeKeeperError)("Error(Contract, #999)"), undefined); // Out of bounds
});
//# sourceMappingURL=errors.test.js.map