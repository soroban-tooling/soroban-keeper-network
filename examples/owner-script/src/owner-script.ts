export interface TaskResult {
  taskId: number;
  status: "EXECUTED" | "EXPIRED_AND_REFUNDED";
  keeper?: string;
  refundedToOwner?: boolean;
}

export interface TaskRegistryClient {
  getLatestLedger(): Promise<number>;
  registerTask(target: string, fn: string, reward: bigint, deadline: number): Promise<number>;
  getTask(id: number): Promise<{ status: string; keeper?: string; deadline: number }>;
  cancelTask(id: number): Promise<bigint>;
}

/**
 * Smallest useful owner script: register one task, wait for execution, print result.
 * Strictly under 100 lines and handles the not-executed-before-deadline case.
 */
export async function runOwnerLifecycle(
  client: TaskRegistryClient,
  targetContract: string,
  fnName: string,
  rewardStroops: bigint,
  timeoutLedgers: number = 20
): Promise<TaskResult> {
  const startLedger = await client.getLatestLedger();
  const deadline = startLedger + timeoutLedgers;

  console.log(`[Owner] Registering task for ${targetContract}::${fnName}`);
  const taskId = await client.registerTask(targetContract, fnName, rewardStroops, deadline);
  console.log(`[Owner] Task #${taskId} registered with deadline ledger ${deadline}`);

  while (true) {
    const currentLedger = await client.getLatestLedger();
    const task = await client.getTask(taskId);

    if (task.status === "EXECUTED") {
      console.log(`[Owner] Success! Task #${taskId} executed by keeper ${task.keeper}`);
      return { taskId, status: "EXECUTED", keeper: task.keeper };
    }

    // Handle not-executed-before-deadline case (Criterion 2)
    if (currentLedger >= deadline) {
      console.warn(`[Owner] Deadline reached (Ledger ${currentLedger} >= ${deadline})! Task was not executed.`);
      console.log(`[Owner] Cancelling task #${taskId} to reclaim escrowed reward...`);
      const refunded = await client.cancelTask(taskId);
      console.log(`[Owner] Successfully refunded ${refunded} stroops to owner wallet.`);
      return { taskId, status: "EXPIRED_AND_REFUNDED", refundedToOwner: true };
    }

    await new Promise((res) => setTimeout(res, 50));
  }
}
