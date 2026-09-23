export interface TaskExecutionPayload {
  taskId: bigint;
  taskType: string;
  creator: string;
  rewardStroops: bigint;
  deadlineLedger: number;
  payload?: any;
}

export interface TaskExecutionResult {
  success: boolean;
  proof?: Buffer | Uint8Array | string;
  error?: string;
  estimatedCostStroops?: bigint;
}

export interface TaskExecutor {
  readonly taskType: string;
  execute(task: TaskExecutionPayload): Promise<TaskExecutionResult>;
}
