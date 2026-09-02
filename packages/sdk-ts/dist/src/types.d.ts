/**
 * Soroban Keeper Network — TypeScript SDK Types
 */
import { KeeperErrorCode } from "./errors";
export declare enum TaskType {
    Liquidation = 0,
    OraclePricePush = 1,
    FundingRateUpdate = 2,
    LiquidityRebalance = 3,
    TtlExtension = 4,
    Custom = 5
}
export declare enum TaskStatus {
    Pending = 0,
    Claimed = 1,
    Executed = 2,
    Expired = 3,
    Cancelled = 4
}
export interface Task {
    id: bigint;
    owner: string;
    taskType: TaskType;
    calldata: Buffer;
    reward: bigint;
    deadline: bigint;
    ttlLedgers: number;
    lockLedgers: number;
    verifier?: string;
    status: TaskStatus;
    claimedBy?: string;
    claimDeadline?: bigint;
}
export interface BatchTaskParams {
    taskType: TaskType | number;
    calldata: Buffer | Uint8Array | string;
    reward: bigint | number | string;
    deadline: bigint | number | string;
    ttlLedgers: number;
    lockLedgers: number;
    verifier?: string;
}
export interface KeeperRegistryClientConfig {
    contractId: string;
    rpcUrl: string;
    networkPassphrase: string;
    secretKey?: string;
}
export interface BuildTransactionOptions {
    sourcePublicKey?: string;
    fee?: number | string;
    timeoutSeconds?: number;
}
export interface BuiltTransaction {
    /**
     * The unsigned transaction envelope XDR string in base64 format.
     */
    unsignedXdr: string;
    /**
     * List of Stellar account public keys required to sign this transaction.
     * For dual-auth operations like `transferAdmin`, this will contain both accounts.
     */
    signers: string[];
}
export interface TransactionResult {
    hash: string;
    status: "SUCCESS" | "FAILED" | string;
    returnValue?: any;
    rawResponse?: any;
}
export interface ResourceCost {
    /**
     * Estimated CPU instructions consumed by simulation.
     */
    cpuInstructions?: number;
    /**
     * Estimated RAM/memory bytes consumed by simulation.
     */
    memoryBytes?: number;
    /**
     * Minimum network resource fee required (in stroops).
     */
    minResourceFee: bigint;
}
export interface TransactionPreviewResult {
    /**
     * Whether the simulated transaction succeeded without contract or host errors.
     */
    success: boolean;
    /**
     * Decoded native return value if the contract call succeeded.
     */
    returnValue?: any;
    /**
     * Estimated resource cost extracted from simulation data.
     */
    resourceCost: ResourceCost;
    /**
     * Raw error string if simulation failed.
     */
    error?: string;
    /**
     * Decoded typed KeeperErrorCode if the failure was a contract business error.
     */
    errorCode?: KeeperErrorCode;
    /**
     * Raw simulation response for advanced inspection.
     */
    rawSimulation?: any;
}
export interface InitializeParams {
    admin: string;
    rewardToken: string;
    feeBps: number;
}
export interface RegisterTaskParams {
    owner: string;
    taskType: TaskType | number;
    calldata: Buffer | Uint8Array | string;
    reward: bigint | number | string;
    deadline: bigint | number | string;
    ttlLedgers: number;
    lockLedgers: number;
    verifier?: string;
}
export interface BatchRegisterTasksParams {
    owner: string;
    tasks: BatchTaskParams[];
    maxTotalReward: bigint | number | string;
}
export interface IncreaseRewardParams {
    owner: string;
    taskId: bigint | number | string;
    additional: bigint | number | string;
}
export interface ExtendDeadlineParams {
    owner: string;
    taskId: bigint | number | string;
    additionalLedgers: bigint | number | string;
}
export interface ClaimTaskParams {
    keeper: string;
    taskId: bigint | number | string;
}
export interface ExecuteTaskParams {
    keeper: string;
    taskId: bigint | number | string;
    proof: Buffer | Uint8Array | string;
}
export interface CancelTaskParams {
    owner: string;
    taskId: bigint | number | string;
}
export interface ExpireTaskParams {
    taskId: bigint | number | string;
}
export interface WithdrawRewardsParams {
    keeper: string;
}
export interface PauseParams {
    admin: string;
}
export interface UnpauseParams {
    admin: string;
}
export interface SetFeeBpsParams {
    admin: string;
    newBps: number;
}
export interface SetMinRewardParams {
    admin: string;
    minReward: bigint | number | string;
}
export interface TransferAdminParams {
    admin: string;
    newAdmin: string;
}
export interface UpgradeParams {
    admin: string;
    newWasmHash: Buffer | Uint8Array | string;
}
export interface SweepFeesParams {
    admin: string;
    treasury: string;
    amount: bigint | number | string;
}
export interface UpdateVerifierParams {
    owner: string;
    taskId: bigint | number | string;
    verifier?: string;
}
//# sourceMappingURL=types.d.ts.map