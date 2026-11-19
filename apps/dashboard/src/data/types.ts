export type TaskStatus = "pending" | "claimed" | "executed" | "cancelled" | "expired";

export interface TaskState {
  task_id: number;
  owner: string;
  keeper?: string | null;
  status: TaskStatus;
  reward: string;
  net_reward: string;
  deadline: number;
  claim_ledger?: number | null;
  last_ledger: number;
  condition?: string | null;
  condition_rejection_count: number;
}

export interface IndexedEvent {
  cursor: number;
  ledger: number;
  ledger_close_time: number;
  tx_hash: string;
  event_index: number;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface LeaderboardEntry {
  rank: number;
  keeper: string;
  executions: number;
  total_reward: string;
  reputation: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export interface RegistryReader {
  keeperBalance(keeper: string): Promise<bigint>;
  keeperStake(keeper: string): Promise<bigint>;
  keeperReputation(keeper: string): Promise<number>;
  pendingUnbond(keeper: string): Promise<{ amount: bigint; unlockLedger: number } | undefined>;
  slashHistory(keeper: string): Promise<{ count: number; totalSlashed: bigint }>;
  getFeeBps(): Promise<number>;
  isPaused(): Promise<boolean>;
  feesAccrued(): Promise<bigint>;
  task(taskId: number): Promise<{ deadline: number; claimLedger?: number; lockLedgers: number }>;
}

export interface RegisterTaskInput {
  owner: string;
  target: string;
  functionName: string;
  argumentsJson: string;
  reward: bigint;
  deadline: number;
  verifier?: string;
}

export interface RegistryOperations {
  estimateRegisterTask(input: RegisterTaskInput): Promise<bigint>;
  registerTask(input: RegisterTaskInput): Promise<bigint>;
  withdrawRewards(keeper: string): Promise<bigint>;
  stake(keeper: string, amount: bigint): Promise<void>;
  unbond(keeper: string, amount: bigint): Promise<void>;
  withdrawStake(keeper: string): Promise<bigint>;
  latestLedger(): Promise<number>;
  increaseReward(owner: string, taskId: number, amount: bigint): Promise<void>;
  extendDeadline(owner: string, taskId: number, deadline: number): Promise<void>;
  cancelTask(owner: string, taskId: number): Promise<void>;
}
