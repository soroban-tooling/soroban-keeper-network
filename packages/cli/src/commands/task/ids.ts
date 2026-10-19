import { UsageError } from "../../args.js";

/**
 * Parses a task ID argument. IDs are positive integers, and the contract starts
 * them at 1. Anything else is a usage error, so a typo never reads task 0.
 */
export function parseTaskId(input: string): bigint {
  if (!/^\d+$/.test(input)) {
    throw new UsageError(`task ID must be a positive integer; got '${input}'`);
  }
  const id = BigInt(input);
  if (id === 0n) {
    throw new UsageError("task IDs start at 1; got 0");
  }
  return id;
}
