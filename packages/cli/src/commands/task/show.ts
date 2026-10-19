import { TaskType, getTask } from "@soroban-keeper-network/sdk";
import { loadConfig, parseCommandArgs, settingFlagsFrom, type CommandContext } from "../../args.js";
import { openRegistry } from "../../client.js";
import { jsonResult, ok, usage, type RunResult } from "../../output.js";
import { resolveSettings } from "../../settings.js";
import { formatRemaining, formatTokenUnits, statusName, taskFields } from "./format.js";
import { parseTaskId } from "./ids.js";

/** `skn task show <id>`: one task's fields, formatted for people, or raw with `--json`. */
export async function runTaskShow(args: readonly string[], context: CommandContext): Promise<RunResult> {
  const { values, positionals } = parseCommandArgs(args, {});
  const json = values.json === true;
  if (positionals.length !== 1) {
    return usage("'skn task show' takes one task ID, for example 'skn task show 7'", json);
  }
  const id = parseTaskId(positionals[0] ?? "");

  const settings = resolveSettings(settingFlagsFrom(values), await loadConfig(context));
  const warnings: string[] = [];
  const client = openRegistry(settings, context, warnings);

  // A missing ID surfaces as a TaskNotFound contract error; the router maps it to exit 5.
  const task = await getTask(client, id);

  if (json) {
    return jsonResult(taskFields(id, task));
  }

  const now = Math.floor(Date.now() / 1000);
  const lines = [
    `task ${id} on ${settings.network}`,
    `status:        ${statusName(task.status)}`,
    `owner:         ${task.owner}`,
    `reward:        ${formatTokenUnits(task.reward)} tokens (${task.reward} stroops)`,
    `deadline:      ${new Date(task.deadline * 1000).toISOString()} (${formatRemaining(task.deadline, now)} left)`,
    `task type:     ${TaskType[task.taskType] ?? task.taskType}`,
    `ttl ledgers:   ${task.ttlLedgers}`,
    `lock ledgers:  ${task.lockLedgers}`,
    `claimer:       ${task.claimer ?? "none"}`,
  ];
  if (task.claimer !== undefined && task.claimLedger !== undefined) {
    lines.push(
      `lock expires:  after ledger ${task.claimLedger + task.lockLedgers} (claimed at ledger ${task.claimLedger})`,
    );
  }
  return ok(`${lines.join("\n")}\n`);
}

