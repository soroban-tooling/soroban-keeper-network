export interface KeeperTask {
  readonly id: bigint;
  readonly taskType: number;
  readonly calldata: Uint8Array;
  readonly rewardStroops: bigint;
  readonly deadlineUnixSeconds: number;
}

export interface ExecutorEstimate {
  readonly expectedCostStroops: bigint;
  readonly worstCaseCostStroops: bigint;
  readonly createdAtMs: number;
  readonly validUntilMs: number;
  readonly idempotent: boolean;
}

export interface EstimateContext {
  readonly estimateContractTtlExtension: (
    contractId: string,
    extendToLedger: number,
  ) => Promise<bigint>;
}

export interface ExecuteContext {
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly extendContractTtl: (
    contractId: string,
    extendToLedger: number,
    idempotencyKey: string,
    signal: AbortSignal,
  ) => Promise<{ transactionHash: string; costStroops: bigint }>;
}

export interface ExecutorResult {
  readonly proof: Uint8Array;
  readonly costStroops: bigint;
}

/**
 * Trusted local plugin contract. Each module exports one executor and declares
 * every on-chain task type it can handle. Returning null refuses the task.
 */
export interface TaskExecutor {
  readonly name: string;
  readonly version: string;
  readonly taskTypes: readonly number[];
  estimate(task: KeeperTask, context: EstimateContext): Promise<ExecutorEstimate>;
  execute(task: KeeperTask, context: ExecuteContext): Promise<ExecutorResult | null>;
}

export interface ExecutorLogger {
  info(event: string, fields: Readonly<Record<string, string>>): void;
}

export class ExecutorRegistry {
  readonly #byTaskType = new Map<number, TaskExecutor>();

  register(executor: TaskExecutor): void {
    validateExecutor(executor);
    for (const taskType of executor.taskTypes) {
      const existing = this.#byTaskType.get(taskType);
      if (existing !== undefined) {
        throw new Error(
          `Task type ${taskType} is already registered by ${existing.name}`,
        );
      }
      this.#byTaskType.set(taskType, executor);
    }
  }

  find(taskType: number): TaskExecutor | undefined {
    return this.#byTaskType.get(taskType);
  }

  get size(): number {
    return this.#byTaskType.size;
  }
}

export async function dispatchTask(
  task: KeeperTask,
  registry: ExecutorRegistry,
  context: ExecuteContext,
  logger: ExecutorLogger,
): Promise<ExecutorResult | null> {
  const executor = registry.find(task.taskType);
  if (executor === undefined) {
    logger.info("task_skipped_no_executor", {
      taskId: task.id.toString(),
      taskType: task.taskType.toString(),
    });
    return null;
  }
  return executor.execute(task, context);
}

function validateExecutor(executor: TaskExecutor): void {
  if (
    typeof executor !== "object" ||
    executor === null ||
    !/^[a-z0-9][a-z0-9-]*$/.test(executor.name) ||
    executor.version.trim() === "" ||
    executor.taskTypes.length === 0 ||
    typeof executor.estimate !== "function" ||
    typeof executor.execute !== "function"
  ) {
    throw new TypeError("Executor module does not implement TaskExecutor");
  }
  if (
    new Set(executor.taskTypes).size !== executor.taskTypes.length ||
    executor.taskTypes.some(
      (taskType) => !Number.isSafeInteger(taskType) || taskType < 0,
    )
  ) {
    throw new TypeError("Executor taskTypes must be unique non-negative integers");
  }
}
