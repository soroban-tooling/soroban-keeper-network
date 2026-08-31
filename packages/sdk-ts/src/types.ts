// Typed mirrors of the keeper-registry contract's on-chain types
// (contracts/keeper-registry/src/types.ts and errors.rs). Field names,
// discriminants, and semantics must stay in sync with the contract — see
// CONVENTIONS.md for the numeric/timestamp representation this SDK uses.

/** Mirrors `contracts/keeper-registry/src/types.rs::TaskType`. */
export enum TaskType {
  Liquidation = 0,
  OraclePricePush = 1,
  FundingRateUpdate = 2,
  LiquidityRebalance = 3,
  TtlExtension = 4,
  Custom = 5,
}

/** Mirrors `contracts/keeper-registry/src/types.rs::TaskStatus`. */
export enum TaskStatus {
  Pending = 0,
  Claimed = 1,
  Executed = 2,
  Cancelled = 3,
  Expired = 4,
}

/**
 * Mirrors `contracts/keeper-registry/src/types.rs::Task`.
 *
 * Numeric convention (CONVENTIONS.md): `reward` is a `bigint` (an `i128` can
 * exceed `Number.MAX_SAFE_INTEGER`); `taskId`, `deadline`, and `claimLedger`
 * stay `number` — a `u64` task id or ledger sequence is astronomically far
 * from overflowing a JS safe integer in this contract's lifetime, and a
 * `number` is far more ergonomic for array indexing, comparisons, and
 * `Date` conversion than a `bigint` would be.
 */
export interface Task {
  owner: string;
  taskType: TaskType;
  calldata: Uint8Array;
  reward: bigint;
  /** Unix timestamp, seconds. */
  deadline: number;
  ttlLedgers: number;
  status: TaskStatus;
  claimer: string | undefined;
  claimLedger: number | undefined;
  lockLedgers: number;
}

/** Which network preset a client is configured against. */
export type NetworkPreset = "testnet" | "futurenet" | "mainnet";

export interface KeeperRegistryClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * A funded account's public key, used as the simulation source for
   * read-only view calls (`getTask`, etc.) that don't otherwise take one
   * explicitly. Soroban simulation requires *some* existing source account
   * even for a call that reads and spends nothing — see
   * `ContractInvoker.read`'s doc comment. Any funded account works; it is
   * never signed with or spent from. Required for the React hooks in this
   * SDK (`useTask`, `useTaskEvents`), which have no natural "current caller"
   * to borrow a source account from.
   */
  readOnlySourceAccount?: string;
}
