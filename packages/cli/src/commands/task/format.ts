import { TaskStatus, type Task } from "@soroban-keeper-network/sdk";

/**
 * Stellar assets carry seven decimal places: 1 token unit is 10,000,000
 * stroops. Rewards are stored in the token's smallest unit, so this is the
 * conversion the human output shows next to the raw value.
 */
export const TOKEN_DECIMALS = 7;

const STATUS_NAMES: Record<TaskStatus, string> = {
  [TaskStatus.Pending]: "pending",
  [TaskStatus.Claimed]: "claimed",
  [TaskStatus.Executed]: "executed",
  [TaskStatus.Cancelled]: "cancelled",
  [TaskStatus.Expired]: "expired",
};

export function statusName(status: TaskStatus): string {
  return STATUS_NAMES[status];
}

/**
 * Parses a status filter: a name (`pending`, `claimed`, ...) or the contract's
 * number. Returns `undefined` for an unknown value, so the caller reports it.
 */
export function parseStatus(input: string): TaskStatus | undefined {
  const lower = input.toLowerCase();
  for (const [value, name] of Object.entries(STATUS_NAMES)) {
    if (name === lower || value === input) return Number(value) as TaskStatus;
  }
  return undefined;
}

/** `12345678` stroops as `1.2345678`, with trailing zeros trimmed but at least one digit kept. */
export function formatTokenUnits(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const scale = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fraction === "" ? "0" : fraction}`;
}

/**
 * Time left until a deadline, in the largest sensible units, or "passed" when it
 * is already over. `deadline` and `nowSeconds` are Unix seconds.
 */
export function formatRemaining(deadline: number, nowSeconds: number): string {
  const seconds = deadline - nowSeconds;
  if (seconds <= 0) return "passed";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** The task's fields as a plain object for `--json`, with its ID attached. */
export function taskFields(id: bigint, task: Task): Record<string, unknown> {
  return { taskId: id, ...task };
}
