/**
 * Core type definitions for keeper-bot-v2
 *
 * This module defines the data structures and interfaces used throughout
 * the keeper-bot-v2 system for candidate task management, profitability
 * evaluation, and round processing.
 */

/**
 * A candidate task discovered from TaskRegistered events
 */
export interface CandidateTask {
  taskId: bigint;
  reward: bigint;
  deadline: number; // Unix seconds
}

/**
 * Full task details fetched from the contract
 */
export interface FullTaskDetails {
  taskType: number;
  calldata: Buffer;
  verifier: string | null;
}

/**
 * An evaluated candidate with both discovered and fetched details
 */
export interface EvaluatedCandidate {
  taskId: bigint;
  taskType: number;
  taskTypeName: string;
  calldata: Buffer;
  reward: bigint;
  deadline: number;
  verifier: string | null;
}

/**
 * Result of profitability evaluation
 */
export interface ProfitabilityResult {
  profitable: boolean;
  estimatedFee: bigint;
  netProfit: bigint;
  reason?: string;
}

/**
 * Extended candidate with profitability information for ranking
 */
export interface RankedCandidate extends EvaluatedCandidate {
  expectedNetProfit: bigint;
  estimatedFee: bigint;
  profitable: boolean;
}

/**
 * Configuration for the keeper bot
 */
export interface KeeperBotConfig {
  network: string;
  registryContractId: string;
  secretKey: string;
  
  // Round processing
  maxTasksPerRound: number;
  pollIntervalMs: number;
  
  // Profitability
  minProfitMarginStroops: bigint;
  estimatedClaimFeeStroops: bigint;
  estimatedExecuteBaseFeeStroops: bigint;
  
  // Optional features
  expireStaleTasks: boolean;
  simulateExecution: boolean;
  
  // Withdrawal
  withdrawThreshold: bigint;
  
  // Retries
  maxRetries: number;
  retryBaseMs: number;
}

/**
 * Summary of a completed round
 */
export interface RoundSummary {
  processed: number;
  selected: bigint[]; // Task IDs that were selected for processing
  skipped: {
    unprofitable: bigint[];
    noExecutor: bigint[];
    pastDeadline: bigint[];
    other: bigint[];
  };
  errors: Array<{
    taskId?: bigint;
    message: string;
  }>;
  totalNetProfit: bigint;
  durationMs: number;
}

/**
 * Context passed to executor functions
 */
export interface ExecutorContext {
  log: (message: string) => void;
  keypairPublicKey: string;
  networkPassphrase: string;
}
