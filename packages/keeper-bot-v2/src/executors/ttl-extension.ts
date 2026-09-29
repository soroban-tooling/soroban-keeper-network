import type {
  ExecutorEstimate,
  KeeperTask,
  TaskExecutor,
} from "./interface.js";

const TTL_EXTENSION_TASK_TYPE = 4;

interface TtlExtensionPayload {
  readonly contractId: string;
  readonly extendToLedger: number;
}

export const ttlExtensionExecutor: TaskExecutor = {
  name: "ttl-extension",
  version: "1.0.0",
  taskTypes: [TTL_EXTENSION_TASK_TYPE],

  async estimate(task, context): Promise<ExecutorEstimate> {
    const payload = decodePayload(task);
    const cost = await context.estimateContractTtlExtension(
      payload.contractId,
      payload.extendToLedger,
    );
    const now = Date.now();
    return {
      expectedCostStroops: cost,
      worstCaseCostStroops: cost,
      createdAtMs: now,
      validUntilMs: now + 30_000,
      idempotent: true,
    };
  },

  async execute(task, context) {
    if (task.deadlineUnixSeconds <= Math.floor(Date.now() / 1_000)) {
      return null;
    }
    const payload = decodePayload(task);
    const result = await context.extendContractTtl(
      payload.contractId,
      payload.extendToLedger,
      context.idempotencyKey,
      context.signal,
    );
    return {
      proof: new TextEncoder().encode(`ttl-extension:${result.transactionHash}`),
      costStroops: result.costStroops,
    };
  },
};

function decodePayload(task: KeeperTask): TtlExtensionPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(task.calldata));
  } catch {
    throw new Error(`Task ${task.id} has invalid TTL extension calldata`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("contractId" in value) ||
    typeof value.contractId !== "string" ||
    value.contractId.trim() === "" ||
    !("extendToLedger" in value) ||
    !Number.isSafeInteger(value.extendToLedger) ||
    Number(value.extendToLedger) <= 0
  ) {
    throw new Error(`Task ${task.id} has invalid TTL extension calldata`);
  }
  return {
    contractId: value.contractId,
    extendToLedger: Number(value.extendToLedger),
  };
}
