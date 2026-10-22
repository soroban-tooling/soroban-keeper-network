import type { Command } from "commander";
import {
  TaskType,
  registerTask,
  type RegisterTaskParams,
} from "@soroban-keeper-network/sdk";

import { parseDeadline } from "../../duration.js";
import { usageError } from "../../errors.js";
import type { Runtime } from "../../runtime.js";
import { openSession, previewingCaller, type GlobalOptions } from "../../session.js";

interface RegisterFlags {
  file?: string;
  type?: string;
  calldata?: string;
  reward?: string;
  deadline?: string;
  ttlLedgers?: string;
  lockLedgers?: string;
  verifier?: string;
  yes?: boolean;
}

/** The same fields as {@link RegisterFlags}, as they appear in a `--file` JSON document. */
interface RegisterFile {
  type?: string | number;
  calldata?: string;
  reward?: string | number;
  deadline?: string | number;
  ttlLedgers?: string | number;
  lockLedgers?: string | number;
  verifier?: string;
}

const TASK_TYPE_NAMES: Readonly<Record<string, TaskType>> = {
  liquidation: TaskType.Liquidation,
  oraclepricepush: TaskType.OraclePricePush,
  fundingrateupdate: TaskType.FundingRateUpdate,
  liquidityrebalance: TaskType.LiquidityRebalance,
  ttlextension: TaskType.TtlExtension,
  custom: TaskType.Custom,
};

/**
 * Reads a task type as a name (`liquidation`, `oracle-price-push`, any case or
 * separator) or as the contract's numeric discriminant.
 */
export function parseTaskType(input: string | number): TaskType {
  const text = String(input).trim();
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (TaskType[value] !== undefined) return value as TaskType;
  } else {
    const named = TASK_TYPE_NAMES[text.toLowerCase().replace(/[^a-z]/g, "")];
    if (named !== undefined) return named;
  }
  throw usageError(
    `Unknown task type "${text}". Use one of: liquidation, oracle-price-push, ` +
      `funding-rate-update, liquidity-rebalance, ttl-extension, custom (or 0-5).`,
  );
}

/** Parses a non-negative whole number given as a string, naming the flag in the error. */
function parseWhole(label: string, input: string | number): bigint {
  const text = String(input).trim();
  if (!/^\d+$/.test(text)) {
    throw usageError(`${label} must be a non-negative whole number, got "${text}".`);
  }
  return BigInt(text);
}

function parseLedgers(label: string, input: string | number): number {
  const value = parseWhole(label, input);
  if (value > 4_294_967_295n) {
    throw usageError(`${label} must fit in a u32, got ${value}.`);
  }
  return Number(value);
}

/** Decodes a hex string, with or without a `0x` prefix, into bytes. */
export function parseHex(label: string, input: string): Uint8Array {
  const text = input.trim().replace(/^0x/i, "");
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw usageError(`${label} must be an even-length hex string, got "${input}".`);
  }
  return new Uint8Array(Buffer.from(text, "hex"));
}

function readJsonFile(rt: Runtime, path: string): RegisterFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rt.readFile(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw usageError(`${path} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`${path} must contain a JSON object.`);
  }
  return parsed as RegisterFile;
}

export function registerTaskRegister(task: Command, rt: Runtime): void {
  task
    .command("register")
    .description("Register a task and escrow its reward")
    .option("--file <path>", "JSON file supplying any of the options below (flags win)")
    .option("--type <name>", "task type: liquidation, oracle-price-push, funding-rate-update, liquidity-rebalance, ttl-extension, custom")
    .option("--calldata <hex>", "opaque calldata for the keeper, as hex (default: empty)")
    .option("--reward <amount>", "reward to escrow, in the reward token's smallest unit")
    .option("--deadline <when>", "deadline: +2h, 2026-12-01T10:00:00Z, or Unix seconds")
    .option("--ttl-ledgers <n>", "ledgers of storage lifetime for the task entry")
    .option("--lock-ledgers <n>", "ledgers a claiming keeper holds the task exclusively")
    .option("--verifier <contract>", "optional verifier contract (C...)")
    .option("--yes", "skip the confirmation prompt")
    .action(async (_flags: RegisterFlags, cmd: Command) => {
      const all = cmd.optsWithGlobals() as RegisterFlags & GlobalOptions;
      const file = all.file ? readJsonFile(rt, all.file) : {};

      const type = all.type ?? file.type;
      const reward = all.reward ?? file.reward;
      const deadline = all.deadline ?? file.deadline;
      const ttl = all.ttlLedgers ?? file.ttlLedgers;
      const lock = all.lockLedgers ?? file.lockLedgers;
      const calldata = all.calldata ?? file.calldata;
      const verifier = all.verifier ?? file.verifier;

      const missing = [
        ["--type", type],
        ["--reward", reward],
        ["--deadline", deadline],
        ["--ttl-ledgers", ttl],
        ["--lock-ledgers", lock],
      ].filter(([, value]) => value === undefined);
      if (missing.length > 0) {
        throw usageError(
          `Missing required input: ${missing.map(([name]) => name).join(", ")} ` +
            `(give it as a flag or in the --file JSON).`,
        );
      }

      const session = openSession(rt, all, { needsKey: true });
      const owner = (session.key as NonNullable<typeof session.key>).publicKey;

      const params: RegisterTaskParams = {
        owner,
        taskType: parseTaskType(type as string | number),
        calldata: calldata === undefined ? new Uint8Array() : parseHex("--calldata", calldata),
        reward: parseWhole("--reward", reward as string | number),
        deadline: parseDeadline(String(deadline), rt.now()),
        ttlLedgers: parseLedgers("--ttl-ledgers", ttl as string | number),
        lockLedgers: parseLedgers("--lock-ledgers", lock as string | number),
        ...(verifier === undefined ? {} : { verifier }),
      };

      const { caller, feeStroops } = previewingCaller(rt, session, { yes: all.yes });
      const taskId = await registerTask(caller, params);

      session.out.result(
        {
          taskId,
          owner,
          taskType: TaskType[params.taskType],
          reward: params.reward,
          deadline: (params.deadline as Date).toISOString(),
          feeStroops: feeStroops() ?? null,
          network: session.conn.network,
          contractId: session.conn.contractId,
        },
        `Registered task #${taskId}`,
      );
    });
}
