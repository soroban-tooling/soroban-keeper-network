import { rpc } from "@stellar/stellar-sdk";
import { KeeperRegistryClientConfig, BuildTransactionOptions, BuiltTransaction, TransactionResult, TransactionPreviewResult, Task, RegisterTaskParams, BatchRegisterTasksParams, IncreaseRewardParams, ExtendDeadlineParams, ClaimTaskParams, ExecuteTaskParams, CancelTaskParams, ExpireTaskParams, WithdrawRewardsParams, PauseParams, UnpauseParams, SetFeeBpsParams, SetMinRewardParams, TransferAdminParams, UpgradeParams, SweepFeesParams, UpdateVerifierParams, InitializeParams } from "./types";
export declare class KeeperRegistryClient {
    readonly contractId: string;
    readonly rpcUrl: string;
    readonly networkPassphrase: string;
    readonly server: rpc.Server;
    private secretKey?;
    constructor(config: KeeperRegistryClientConfig);
    /**
     * Lower-level method: Builds an unsigned transaction XDR plus required signers metadata.
     *
     * Recommended for browser dApps integrating with wallet extensions (Freighter, Wallet-Kit).
     *
     * @param methodName Method name to invoke (e.g. "registerTask", "transferAdmin")
     * @param params Method parameters
     * @param options Building options (sourcePublicKey, fee, timeoutSeconds)
     */
    buildTransaction(methodName: string, params: Record<string, any>, options?: BuildTransactionOptions): Promise<BuiltTransaction>;
    /**
     * Lower-level method: Previews a transaction simulation before submission without requiring any signers or private keys.
     * Returns resource costs (minResourceFee, cpuInstructions, memoryBytes) and simulated return value (or decoded typed KeeperErrorCode).
     *
     * @param methodName Method name to preview (e.g. "registerTask", "claimTask")
     * @param params Method parameters
     * @param options Preview options (sourcePublicKey, fee, timeoutSeconds)
     */
    previewTransaction(methodName: string, params: Record<string, any>, options?: BuildTransactionOptions): Promise<TransactionPreviewResult>;
    /**
     * Lower-level method: Submits a signed transaction XDR base64 string to the Soroban RPC server
     * and polls until confirmation.
     *
     * @param signedXdr The signed transaction XDR base64 string
     */
    submitSignedTransaction(signedXdr: string): Promise<TransactionResult>;
    /**
     * Helper to execute convenience server-side signing for mutating methods.
     */
    private executeWithSecretKey;
    registerTask(params: RegisterTaskParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    batchRegisterTasks(params: BatchRegisterTasksParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    increaseReward(params: IncreaseRewardParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    extendDeadline(params: ExtendDeadlineParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    claimTask(params: ClaimTaskParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    executeTask(params: ExecuteTaskParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    cancelTask(params: CancelTaskParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    expireTask(params: ExpireTaskParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    withdrawRewards(params: WithdrawRewardsParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    pause(params: PauseParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    unpause(params: UnpauseParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    setFeeBps(params: SetFeeBpsParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    setMinReward(params: SetMinRewardParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    /**
     * Dual-auth admin transfer: requires signatures from both `admin` and `newAdmin`.
     * Pass both secret keys in options.additionalSecretKeys for server-side keypair calls,
     * or use `buildTransaction("transferAdmin", { admin, newAdmin })` for wallet flows.
     */
    transferAdmin(params: TransferAdminParams, options?: BuildTransactionOptions & {
        newAdminSecretKey?: string;
    }): Promise<TransactionResult>;
    upgrade(params: UpgradeParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    sweepFees(params: SweepFeesParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    updateVerifier(params: UpdateVerifierParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    initialize(params: InitializeParams, options?: BuildTransactionOptions): Promise<TransactionResult>;
    private readContract;
    getTask(taskId: bigint | number | string, sourcePublicKey?: string): Promise<Task | null>;
    taskCount(sourcePublicKey?: string): Promise<bigint>;
    keeperBalance(keeper: string, sourcePublicKey?: string): Promise<bigint>;
    feesAccrued(sourcePublicKey?: string): Promise<bigint>;
    isPaused(sourcePublicKey?: string): Promise<boolean>;
    admin(sourcePublicKey?: string): Promise<string | null>;
    getFeeBps(sourcePublicKey?: string): Promise<number>;
    rewardTokenAddress(sourcePublicKey?: string): Promise<string | null>;
}
//# sourceMappingURL=client.d.ts.map