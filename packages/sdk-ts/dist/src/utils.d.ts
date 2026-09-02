import { scValToNative, xdr } from "@stellar/stellar-sdk";
/**
 * Validates a Soroban contract ID string (C...).
 */
export declare function validateContractId(contractId: string): void;
/**
 * Validates a Stellar account public key or contract address (G... or C...).
 */
export declare function validateAddress(address: string, label?: string): void;
/**
 * Validates a Stellar secret key (S...).
 */
export declare function validateSecretKey(secretKey: string): void;
/**
 * Converts a byte array, Buffer, or hex string into a Buffer.
 */
export declare function toBuffer(val: Buffer | Uint8Array | string): Buffer;
/**
 * Encodes JavaScript types into Soroban ScVals for contract call arguments.
 */
export declare function encodeScVal(val: any, type: string): xdr.ScVal;
export { scValToNative };
//# sourceMappingURL=utils.d.ts.map