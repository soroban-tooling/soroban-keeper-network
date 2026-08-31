// packages/sdk-ts/src/methods/batchRegisterTasks.ts

import type { TaskParams } from "../types";
import type { KeeperRegistryClient } from "../client";

export interface BatchRegisterTasksParams {
  owner: string;
  tasks: TaskParams[];
  maxTotalReward: bigint;
}

export async function batchRegisterTasks(
  client: KeeperRegistryClient,
  params: BatchRegisterTasksParams,
): Promise<bigint[]> {
  if (params.tasks.length === 0) {
    throw new Error(
      "batchRegisterTasks requires at least one task",
    );
  }

  const totalReward = params.tasks.reduce(
    (total, task) => total + BigInt(task.reward),
    0n,
  );

  if (totalReward > BigInt(params.maxTotalReward)) {
    throw new Error(
      `Batch reward ${totalReward} exceeds maxTotalReward ${params.maxTotalReward}`,
    );
  }

  const taskIds = await client.invokeContract<
    bigint[]
  >("batch_register_tasks", {
    owner: params.owner,
    tasks: params.tasks,
    max_total_reward: params.maxTotalReward,
  });

  if (taskIds.length !== params.tasks.length) {
    throw new Error(
      "Contract returned a task-id count that does not match the input batch",
    );
  }

  return taskIds;
}
