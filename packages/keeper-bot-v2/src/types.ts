/**
 * Shared type definitions for keeper-bot-v2.
 */

export interface Config {
  network: string;
  registryContractId: string;
  keeperSecretKey: string;
  maxRetries: number;
  retryBaseMs: number;
  pollIntervalMs: number;
  consecutiveExhaustedRetriesForDegradedMode: number;
  degradedModePollingIntervalMs: number;
  maxTasksPerRound: number;
  withdrawThreshold: bigint;
  minProfitMarginStroops: bigint;
  expireStaleTasks: boolean;
}

export interface Alert {
  type: "degraded-mode-entry" | "degraded-mode-exit" | "rpc-error" | "missed-execution";
  severity: "warning" | "critical";
  message: string;
  timestamp: number;
  taskId?: string;
}

export interface AlertTransport {
  raise(alert: Alert): Promise<void>;
}

export interface DegradedModeState {
  isDegraded: boolean;
  consecutiveExhaustedSequences: number;
  alertSentInCurrentEpisode: boolean;
}
