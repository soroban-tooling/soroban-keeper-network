"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scValToNative = void 0;
exports.validateContractId = validateContractId;
exports.validateAddress = validateAddress;
exports.validateSecretKey = validateSecretKey;
exports.toBuffer = toBuffer;
exports.encodeScVal = encodeScVal;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
Object.defineProperty(exports, "scValToNative", { enumerable: true, get: function () { return stellar_sdk_1.scValToNative; } });
/**
 * Validates a Soroban contract ID string (C...).
 */
function validateContractId(contractId) {
    if (!contractId || typeof contractId !== "string" || !stellar_sdk_1.StrKey.isValidContract(contractId)) {
        throw new Error(`Invalid contract ID: "${contractId}". Must be a valid C... address.`);
    }
}
/**
 * Validates a Stellar account public key or contract address (G... or C...).
 */
function validateAddress(address, label = "address") {
    if (!address || typeof address !== "string") {
        throw new Error(`Invalid ${label}: address must be a non-empty string.`);
    }
    const isAccount = stellar_sdk_1.StrKey.isValidEd25519PublicKey(address);
    const isContract = stellar_sdk_1.StrKey.isValidContract(address);
    if (!isAccount && !isContract) {
        throw new Error(`Invalid ${label}: "${address}". Must be a valid Stellar public key (G...) or contract ID (C...).`);
    }
}
/**
 * Validates a Stellar secret key (S...).
 */
function validateSecretKey(secretKey) {
    if (!secretKey || typeof secretKey !== "string" || !stellar_sdk_1.StrKey.isValidEd25519SecretSeed(secretKey)) {
        throw new Error(`Invalid secret key. Must be a valid S... seed.`);
    }
}
/**
 * Converts a byte array, Buffer, or hex string into a Buffer.
 */
function toBuffer(val) {
    if (Buffer.isBuffer(val)) {
        return val;
    }
    if (val instanceof Uint8Array) {
        return Buffer.from(val);
    }
    if (typeof val === "string") {
        if (val.startsWith("0x")) {
            return Buffer.from(val.slice(2), "hex");
        }
        // Check if valid hex
        if (/^[0-9a-fA-F]*$/.test(val) && val.length % 2 === 0) {
            return Buffer.from(val, "hex");
        }
        return Buffer.from(val, "utf-8");
    }
    throw new Error(`Cannot convert value of type ${typeof val} to Buffer.`);
}
/**
 * Encodes JavaScript types into Soroban ScVals for contract call arguments.
 */
function encodeScVal(val, type) {
    switch (type) {
        case "address":
            validateAddress(val);
            return (0, stellar_sdk_1.nativeToScVal)(val, { type: "address" });
        case "u32":
            return (0, stellar_sdk_1.nativeToScVal)(Number(val), { type: "u32" });
        case "u64":
            return (0, stellar_sdk_1.nativeToScVal)(BigInt(val), { type: "u64" });
        case "i128":
            return (0, stellar_sdk_1.nativeToScVal)(BigInt(val), { type: "i128" });
        case "bytes":
            return (0, stellar_sdk_1.nativeToScVal)(toBuffer(val), { type: "bytes" });
        case "bytes32": {
            const buf = toBuffer(val);
            if (buf.length !== 32) {
                throw new Error(`Invalid BytesN<32> length: expected 32 bytes, got ${buf.length}.`);
            }
            return (0, stellar_sdk_1.nativeToScVal)(buf, { type: "bytes" });
        }
        case "opt_address":
            if (val === undefined || val === null) {
                return (0, stellar_sdk_1.nativeToScVal)(null);
            }
            validateAddress(val);
            return (0, stellar_sdk_1.nativeToScVal)(val, { type: "address" });
        default:
            return (0, stellar_sdk_1.nativeToScVal)(val);
    }
}
//# sourceMappingURL=utils.js.map