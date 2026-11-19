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
}
