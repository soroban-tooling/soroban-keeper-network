import { rpc, xdr } from "@stellar/stellar-sdk";
import { BuiltTransaction, BuildTransactionOptions, ResourceCost, TransactionPreviewResult } from "./types";
/**
 * Normalizes camelCase method names to contract snake_case function names.
 */
export declare function normalizeMethodName(methodName: string): string;
/**
 * Determines which accounts must sign the transaction based on the contract method and parameters.
 */
export declare function getRequiredSigners(methodName: string, params: Record<string, any>): string[];
/**
 * Encodes method parameters into an ordered array of Soroban ScVal contract arguments.
 */
export declare function encodeMethodArgs(methodName: string, params: Record<string, any>): xdr.ScVal[];
/**
 * Extracts resource cost metrics (minResourceFee, cpuInstructions, memoryBytes) from simulation response.
 */
export declare function extractResourceCost(simResponse: any): ResourceCost;
/**
 * Builds an unsigned Soroban transaction for any mutating contract method.
 */
export declare function buildTransaction(server: rpc.Server, contractId: string, networkPassphrase: string, methodName: string, params: Record<string, any>, options?: BuildTransactionOptions): Promise<BuiltTransaction>;
/**
 * Previews a transaction simulation without requiring any signers or private keys.
 * Returns estimated resource costs and expected return value (or decoded typed KeeperErrorCode if failed).
 */
export declare function previewTransaction(server: rpc.Server, contractId: string, networkPassphrase: string, methodName: string, params: Record<string, any>, options?: BuildTransactionOptions): Promise<TransactionPreviewResult>;
//# sourceMappingURL=transactionBuilder.d.ts.map