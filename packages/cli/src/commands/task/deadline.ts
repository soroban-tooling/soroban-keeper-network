import { UsageError } from "../../args.js";

const RELATIVE = /^\+(\d+)([smhd])$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/**
 * Parses a task deadline into Unix seconds. Accepts an ISO 8601 timestamp, or a
 * duration from now: `+90s`, `+30m`, `+2h`, `+7d`. Anything else is a usage
 * error. Whether the result is in the future is checked by the SDK.
 */
export function parseDeadline(input: string, nowSeconds: number): number {
  const relative = RELATIVE.exec(input);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_SECONDS[relative[2] as string] as number;
    return nowSeconds + amount * unit;
  }
  const millis = Date.parse(input);
  if (!Number.isNaN(millis) && /\d{4}-\d{2}-\d{2}/.test(input)) {
    return Math.floor(millis / 1000);
  }
  throw new UsageError(
    `deadline must be an ISO timestamp (for example 2030-01-01T00:00:00Z) or a duration like +2h; got '${input}'`,
  );
}
