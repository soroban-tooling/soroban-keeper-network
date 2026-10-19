import { taskCount, getTasksRange, TaskStatus, type Task } from "@soroban-keeper-network/sdk";
import {
  UsageError,
  loadConfig,
  parseCommandArgs,
  settingFlagsFrom,
  type CommandContext,
} from "../../args.js";
import { openRegistry } from "../../client.js";
import { fetchIndexerTasks, type FetchLike, type IndexerTaskState } from "../../indexer.js";
import { jsonResult, ok, usage, type RunResult } from "../../output.js";
import { resolveSettings } from "../../settings.js";
import { formatTokenUnits, parseStatus, statusName, taskFields } from "./format.js";

/** The contract reads at most this many IDs per `get_tasks_range` call. */
const CONTRACT_READ_WINDOW = 50;
/** Upper bound on IDs one invocation scans, so a sparse filter cannot run forever. */
const MAX_SCAN_PER_CALL = 1_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface TaskListOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike | undefined;
  /** Clock in Unix seconds. Injected for tests. */
  now?: (() => number) | undefined;
}

interface Filters {
  status: TaskStatus | undefined;
  owner: string | undefined;
  keeper: string | undefined;
}

interface ListRow {
  taskId: bigint;
  fields: Record<string, unknown>;
  owner: string;
  status: string;
  reward: bigint;
  deadline: number;
}

/**
 * `skn task list`: tasks filtered by status, owner or keeper, one page at a time.
 *
 * The source is the indexer when `--indexer-url` or `SKN_INDEXER_URL` is set,
 * and the chain otherwise. The indexer can only list by owner or keeper, so
 * with it a list needs one of those filters. The chain answers any filter by
 * scanning IDs, and reports which source answered.
 */
export async function runTaskList(
  args: readonly string[],
  context: CommandContext,
  options: TaskListOptions = {},
): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {
    status: { type: "string" },
    owner: { type: "string" },
    keeper: { type: "string" },
    limit: { type: "string" },
    cursor: { type: "string" },
    "indexer-url": { type: "string" },
  });
  const json = values.json === true;
  if (positionals.length > 0) {
    return usage(`'skn task list' takes no arguments; got '${positionals[0]}'`, json);
  }

  const filters = parseFilters(values);
  const limit = parseLimit(values.limit as string | undefined);
  const indexerUrl = (values["indexer-url"] as string | undefined) ?? context.env["SKN_INDEXER_URL"];
  const settings = resolveSettings(settingFlagsFrom(values), await loadConfig(context));

  if (indexerUrl !== undefined && indexerUrl !== "") {
    return listFromIndexer(indexerUrl, filters, limit, values.cursor as string | undefined, json, options);
  }
  return listFromChain(settings, context, filters, limit, values.cursor as string | undefined, json);
}

function parseFilters(values: Record<string, string | boolean | undefined>): Filters {
  const rawStatus = values.status as string | undefined;
  let status: TaskStatus | undefined;
  if (rawStatus !== undefined) {
    status = parseStatus(rawStatus);
    if (status === undefined) {
      throw new UsageError(`unknown status '${rawStatus}'; expected pending, claimed, executed, cancelled or expired`);
    }
  }
  return {
    status,
    owner: values.owner as string | undefined,
    keeper: values.keeper as string | undefined,
  };
}

function parseLimit(input: string | undefined): number {
  if (input === undefined) return DEFAULT_LIMIT;
  const limit = Number(input);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new UsageError(`--limit must be an integer from 1 to ${MAX_LIMIT}; got '${input}'`);
  }
  return limit;
}

async function listFromChain(
  settings: ReturnType<typeof resolveSettings>,
  context: CommandContext,
  filters: Filters,
  limit: number,
  cursor: string | undefined,
  json: boolean,
): Promise<RunResult> {
  const warnings: string[] = [];
  const client = openRegistry(settings, context, warnings);
  const total = BigInt(await taskCount(client));
  let next = parseCursor(cursor, 1n, "chain");

  const rows: ListRow[] = [];
  let scanned = 0n;
  let nextCursor: bigint | null = null;

  scan: while (next <= total && scanned < BigInt(MAX_SCAN_PER_CALL)) {
    const remaining = total - next + 1n;
    const count = Number(remaining < BigInt(CONTRACT_READ_WINDOW) ? remaining : BigInt(CONTRACT_READ_WINDOW));
    const page = await getTasksRange(client, next, count);

    // Walk the IDs that were asked for, not whatever the RPC returned.
    for (let i = 0; i < count; i += 1) {
      const id = next + BigInt(i);
      const task = page[i];
      if (task === undefined || !matchesChain(task, filters)) continue;
      rows.push({
        taskId: id,
        fields: taskFields(id, task),
        owner: task.owner,
        status: statusName(task.status),
        reward: task.reward,
        deadline: task.deadline,
      });
      if (rows.length === limit) {
        // Resume at the next ID after the last one returned, so no task is skipped.
        nextCursor = id + 1n <= total ? id + 1n : null;
        break scan;
      }
    }
    next += BigInt(count);
    scanned += BigInt(count);
  }
  if (rows.length < limit && next <= total) nextCursor = next;

  return renderList(rows, "chain", filters, nextCursor, json, warnings);
}

function matchesChain(task: Task, filters: Filters): boolean {
  if (filters.status !== undefined && task.status !== filters.status) return false;
  if (filters.owner !== undefined && task.owner !== filters.owner) return false;
  // On the chain, a keeper's claim is the task's current claimer. Past executions
  // are history, which only the indexer keeps.
  if (filters.keeper !== undefined && task.claimer !== filters.keeper) return false;
  return true;
}

async function listFromIndexer(
  baseUrl: string,
  filters: Filters,
  limit: number,
  cursor: string | undefined,
  json: boolean,
  options: TaskListOptions,
): Promise<RunResult> {
  if (filters.owner !== undefined && filters.keeper !== undefined) {
    return usage("the indexer lists by --owner or by --keeper, not both", json);
  }
  if (filters.owner === undefined && filters.keeper === undefined) {
    return usage(
      "with the indexer, 'skn task list' needs --owner or --keeper, because the indexer cannot list every task. Drop --indexer-url to list from the chain.",
      json,
    );
  }

  const path =
    filters.owner !== undefined
      ? { kind: "owner" as const, address: filters.owner }
      : { kind: "keeper" as const, address: filters.keeper as string };
  const list = await fetchIndexerTasks(baseUrl, path, options.fetch ?? (globalThis.fetch as FetchLike));

  // With the indexer, the cursor is an offset into the matching tasks.
  const start = Number(parseCursor(cursor, 0n, "indexer"));
  const matching = list.tasks.filter((task) => matchesIndexer(task, filters));
  const slice = matching.slice(start, start + limit);
  const rows: ListRow[] = slice.map((task) => ({
    taskId: BigInt(task.task_id),
    fields: {
      taskId: task.task_id,
      owner: task.owner,
      status: task.status,
      keeper: task.keeper,
      reward: task.reward,
      deadline: task.deadline,
    },
    owner: task.owner,
    status: task.status,
    reward: BigInt(task.reward),
    deadline: task.deadline,
  }));
  const end = start + slice.length;
  const nextCursor = end < matching.length ? BigInt(end) : null;

  return renderList(rows, "indexer", filters, nextCursor, json, []);
}

function matchesIndexer(task: IndexerTaskState, filters: Filters): boolean {
  if (filters.status !== undefined && task.status !== statusName(filters.status)) return false;
  return true;
}

function parseCursor(input: string | undefined, fallback: bigint, source: "chain" | "indexer"): bigint {
  if (input === undefined) return fallback;
  const minimum = source === "chain" ? 1n : 0n;
  if (!/^\d+$/.test(input) || BigInt(input) < minimum) {
    throw new UsageError(
      source === "chain"
        ? `--cursor must be a task ID, 1 or higher; got '${input}'`
        : `--cursor must be a non-negative offset; got '${input}'`,
    );
  }
  return BigInt(input);
}

function renderList(
  rows: ListRow[],
  source: "chain" | "indexer",
  filters: Filters,
  nextCursor: bigint | null,
  json: boolean,
  warnings: string[],
): RunResult {
  const stderr = warnings.map((line) => `skn: warning: ${line}\n`).join("");
  if (json) {
    const result = jsonResult({
      source,
      filters: {
        status: filters.status === undefined ? null : statusName(filters.status),
        owner: filters.owner ?? null,
        keeper: filters.keeper ?? null,
      },
      tasks: rows.map((row) => row.fields),
      nextCursor: nextCursor === null ? null : nextCursor.toString(),
    });
    return { ...result, stderr };
  }

  const lines = [`source: ${source}`];
  if (rows.length === 0) {
    lines.push("no tasks match");
  } else {
    lines.push("ID          STATUS     REWARD           DEADLINE (unix)  OWNER");
    for (const row of rows) {
      lines.push(
        `${row.taskId.toString().padEnd(11)} ${row.status.padEnd(10)} ${formatTokenUnits(row.reward).padEnd(16)} ${String(row.deadline).padEnd(16)} ${row.owner}`,
      );
    }
  }
  if (nextCursor !== null) {
    lines.push(`next page: --cursor ${nextCursor.toString()}`);
  }
  return { ...ok(`${lines.join("\n")}\n`), stderr };
}
