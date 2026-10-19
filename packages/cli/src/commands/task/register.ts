import { readFile } from "node:fs/promises";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  MAX_CALLDATA_LEN,
  MAX_LOCK_LEDGERS,
  MIN_LOCK_LEDGERS,
  MIN_TTL_LEDGERS,
  TaskType,
  keypairSigner,
  registerTask,
  type RegisterTaskParams,
  type RpcServerLike,
} from "@soroban-keeper-network/sdk";
import {
  UsageError,
  loadConfig,
  parseCommandArgs,
  settingFlagsFrom,
  type CommandContext,
  type ParsedValues,
} from "../../args.js";
import { openRegistry } from "../../client.js";
import { resolveKey, type KeyContext } from "../../keys.js";
import { jsonResult, ok, usage, type RunResult } from "../../output.js";
import { resolveSettings, type Settings } from "../../settings.js";
import { commandError } from "../../failures.js";
import { parseDeadline } from "./deadline.js";

/** Defaults when a flag and the file both leave a value out. */
const DEFAULT_TTL_LEDGERS = MIN_TTL_LEDGERS;
const DEFAULT_LOCK_LEDGERS = 120;

/** Asks the person to confirm the submission. The bin supplies a readline prompt; tests supply a stub. */
export type ConfirmFn = (question: string) => Promise<boolean>;

export interface TaskRegisterOptions {
  /** Interactive confirmation. Absent when stdin is not a terminal, in which case `--yes` is required. */
  confirm?: ConfirmFn | undefined;
  /** Clock in Unix seconds. Injected for tests. */
  now?: (() => number) | undefined;
}

/** What the command will register, after flags and the optional file are merged. */
interface TaskSpec {
  target: string;
  functionName: string;
  args: unknown[];
  reward: bigint;
  deadline: string;
  verifier: string | undefined;
  taskType: TaskType;
  ttlLedgers: number;
  lockLedgers: number;
}

/**
 * `skn task register`: registers a task. The command simulates first, shows the
 * estimated resource fee, and asks before it submits. `--yes` skips the prompt.
 * Only the simulation is shown to the RPC server before the prompt; nothing is
 * submitted until the person confirms.
 */
export async function runTaskRegister(
  args: readonly string[],
  context: CommandContext,
  options: TaskRegisterOptions = {},
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {
    from: { type: "string" },
    target: { type: "string" },
    function: { type: "string" },
    args: { type: "string" },
    reward: { type: "string" },
    deadline: { type: "string" },
    verifier: { type: "string" },
    "task-type": { type: "string" },
    "ttl-ledgers": { type: "string" },
    "lock-ledgers": { type: "string" },
    yes: { type: "boolean" },
  });
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn task register' takes no arguments; got '${positionals[0]}'`, json);
  }

  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const spec = await buildSpec(values);
  const deadlineSeconds = parseDeadline(spec.deadline, now());
  const calldata = encodeCalldata(spec);

  const settings = resolveSettings(settingFlagsFrom(values), await loadConfig(context));
  const keyContext: KeyContext = { env: context.env, homeDir: context.homeDir, platform: context.platform };
  const key = await resolveKey(
    {
      keyFile: values["key-file"] as string | undefined,
      identity: values.identity as string | undefined,
    },
    keyContext,
  );
  if (key === undefined) {
    return usage("no signing key: set --key-file, --identity, or SKN_SECRET_KEY", json);
  }
  const keypair = Keypair.fromSecret(key.secret);
  const signer = keypairSigner(keypair);

  const params: RegisterTaskParams = {
    owner: keypair.publicKey(),
    taskType: spec.taskType,
    calldata,
    reward: spec.reward,
    deadline: deadlineSeconds,
    ttlLedgers: spec.ttlLedgers,
    lockLedgers: spec.lockLedgers,
    ...(spec.verifier === undefined ? {} : { verifier: spec.verifier }),
    signer,
  };

  const inner = (context.server ?? new rpc.Server(settings.rpcUrl)) as RpcServerLike;

  // Step 1: simulate with a server that stops before submission and records the fee.
  const capture: FeeCapture = { stopped: false, resourceFee: undefined };
  const warnings: string[] = [];
  try {
    const previewClient = openRegistry(settings, context, warnings, {
      signer,
      server: previewServer(inner, capture),
    });
    await registerTask(previewClient, params);
  } catch (err) {
    if (!capture.stopped) return commandError(err, json);
  }
  const fee = capture.resourceFee;
  const feeText = fee === undefined ? "unavailable" : `${fee} stroops`;

  // Step 2: confirm.
  if (!values.yes) {
    if (options.confirm === undefined) {
      return usage(
        `not submitted: pass --yes to submit without a prompt. Estimated resource fee: ${feeText}`,
        json,
      );
    }
    const question = `Register task on ${settings.network}: reward ${spec.reward} stroops, deadline ${deadlineSeconds}, estimated resource fee ${feeText}. Submit? [y/N] `;
    const confirmed = await options.confirm(question);
    if (!confirmed) {
      return json
        ? jsonResult({ submitted: false, estimatedResourceFeeStroops: fee ?? null })
        : ok("not submitted\n");
    }
  }

  // Step 3: submit for real.
  const client = openRegistry(settings, context, warnings, { signer, server: inner });
  const taskId = await registerTask(client, params);
  const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");

  if (json) {
    return { ...jsonResult({
      submitted: true,
      taskId,
      estimatedResourceFeeStroops: fee ?? null,
    }), stderr };
  }
  return { ...ok(`registered task ${taskId} on ${settings.network}\n`), stderr };
}

interface FeeCapture {
  stopped: boolean;
  resourceFee: string | undefined;
}

/** Thrown by the preview server at the moment the transaction would be submitted. */
class PreviewStop extends Error {}

/**
 * Wraps a real RPC server for the preview. Simulation passes through, and the
 * resource fee it reports is recorded. Submission throws `PreviewStop`, so the
 * SDK stops before anything is sent.
 */
function previewServer(inner: RpcServerLike, capture: FeeCapture): RpcServerLike {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "simulateTransaction") {
        return async (...args: Parameters<RpcServerLike["simulateTransaction"]>) => {
          const response = await target.simulateTransaction(...args);
          const fee = (response as { minResourceFee?: string }).minResourceFee;
          if (fee !== undefined) capture.resourceFee = String(fee);
          return response;
        };
      }
      if (property === "sendTransaction") {
        return async () => {
          capture.stopped = true;
          throw new PreviewStop("preview only: not submitted");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Merges the optional `--from` file with flags. Flags win; missing required values are usage errors. */
async function buildSpec(values: ParsedValues): Promise<TaskSpec> {
  const fromFile = values.from as string | undefined;
  const file = fromFile === undefined ? {} : await readSpecFile(fromFile);
  const pick = (flag: string, key: string): string | undefined =>
    (values[flag] as string | undefined) ?? (file[key] as string | undefined);

  const target = pick("target", "target");
  const functionName = pick("function", "function");
  const reward = pick("reward", "reward");
  const deadline = pick("deadline", "deadline");
  if (target === undefined) throw new UsageError("--target is required: the contract the keeper calls");
  if (functionName === undefined) throw new UsageError("--function is required: the function to call");
  if (reward === undefined) throw new UsageError("--reward is required, in stroops");
  if (deadline === undefined) throw new UsageError("--deadline is required");

  const argsText = values.args as string | undefined;
  let args: unknown[] = [];
  if (argsText !== undefined) {
    args = parseArgsArray(argsText);
  } else if (Array.isArray(file["args"])) {
    args = file["args"] as unknown[];
  }

  const rewardValue = parseReward(reward);
  return {
    target,
    functionName,
    args,
    reward: rewardValue,
    deadline,
    verifier: pick("verifier", "verifier"),
    taskType: parseTaskType(
      (values["task-type"] as string | undefined) ?? (file["taskType"] as string | undefined) ?? "custom",
    ),
    ttlLedgers: parseBoundedInt(
      "--ttl-ledgers",
      (values["ttl-ledgers"] as string | undefined) ?? (file["ttlLedgers"] as string | undefined),
      DEFAULT_TTL_LEDGERS,
      MIN_TTL_LEDGERS,
      Number.MAX_SAFE_INTEGER,
    ),
    lockLedgers: parseBoundedInt(
      "--lock-ledgers",
      (values["lock-ledgers"] as string | undefined) ?? (file["lockLedgers"] as string | undefined),
      DEFAULT_LOCK_LEDGERS,
      MIN_LOCK_LEDGERS,
      MAX_LOCK_LEDGERS,
    ),
  };
}

async function readSpecFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read task file ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`task file ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`task file ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseArgsArray(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--args must be a JSON array, for example '[\"G...\", 5]'");
  }
  if (!Array.isArray(parsed)) throw new UsageError("--args must be a JSON array");
  return parsed;
}

function parseReward(input: string): bigint {
  if (!/^\d+$/.test(input) || BigInt(input) === 0n) {
    throw new UsageError(`--reward must be a positive whole number of stroops; got '${input}'`);
  }
  return BigInt(input);
}

function parseTaskType(input: string): TaskType {
  const byName = TaskType[input as keyof typeof TaskType];
  if (byName !== undefined && typeof byName === "number") return byName;
  const numeric = Number(input);
  if (Number.isInteger(numeric) && numeric in TaskType) return numeric as TaskType;
  const lower = input.toLowerCase();
  const found = (Object.keys(TaskType) as (keyof typeof TaskType)[]).find(
    (name) => isNaN(Number(name)) && name.toLowerCase() === lower,
  );
  if (found !== undefined) return TaskType[found];
  throw new UsageError(`unknown task type '${input}'`);
}

function parseBoundedInt(
  flag: string,
  input: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (input === undefined) return fallback;
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${flag} must be an integer from ${min} to ${max}; got '${input}'`);
  }
  return value;
}

/**
 * The calldata a keeper decodes to make the call: UTF-8 JSON of the target
 * contract, the function, and its arguments. The contract stores these bytes
 * without reading them. Keepers that execute tasks must use the same format.
 */
function encodeCalldata(spec: TaskSpec): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ contract: spec.target, function: spec.functionName, args: spec.args }),
  );
  if (bytes.length > MAX_CALLDATA_LEN) {
    throw new UsageError(
      `the call's calldata is ${bytes.length} bytes; the limit is ${MAX_CALLDATA_LEN}. Use fewer or shorter arguments.`,
    );
  }
  return bytes;
}

