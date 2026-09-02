/**
 * Soroban Keeper Network — Typed Error Decoding
 */
/**
 * TypeScript enum mirroring the contract's KeeperError discriminants in `contracts/keeper-registry/src/errors.rs`.
 */
export declare enum KeeperErrorCode {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    ContractPaused = 3,
    TaskNotFound = 4,
    InvalidTaskStatus = 5,
    DeadlinePassed = 6,
    DeadlineNotPassed = 7,
    InvalidReward = 8,
    LockPeriodActive = 9,
    InvalidFeeBps = 10,
    NotTaskOwner = 11,
    NotTaskClaimer = 12,
    NoRewardsAvailable = 13,
    ProofTooLarge = 14,
    NotInitialized = 15,
    TtlTooShort = 16,
    CalldataTooLarge = 17,
    InvalidTaskParams = 18,
    ArithmeticOverflow = 19,
    IncompatibleVerifierInterface = 20,
    BatchTooLarge = 21,
    EmptyBatch = 22,
    BatchRewardCeilingExceeded = 23
}
/**
 * Decodes a simulation error message or response into a typed `KeeperErrorCode`.
 * Returns `undefined` if the error was a host-level or network-level error rather than a contract `KeeperError`.
 *
 * @param error The raw error string, Error object, or simulation error response
 */
export declare function decodeKeeperError(error: any): KeeperErrorCode | undefined;
//# sourceMappingURL=errors.d.ts.map