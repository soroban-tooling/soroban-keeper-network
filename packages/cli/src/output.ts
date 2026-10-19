import { EXIT, type ExitCode } from "./exitCodes.js";

/** What a command prints and how it exits. Every command returns one of these. */
export interface RunResult {
  exitCode: ExitCode;
  stdout: string;
  stderr: string;
}

export function ok(stdout: string): RunResult {
  return { exitCode: EXIT.ok, stdout, stderr: "" };
}

/**
 * Serializes a value for `--json`. Bigints become decimal strings, because a
 * JSON number cannot hold an amount of stroops or a ledger-scale value exactly.
 * Everything else is passed through unchanged.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  // Bytes (such as a task's calldata) go out as base64, not as an index-keyed object.
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, toJsonSafe(field)]),
    );
  }
  return value;
}

/** A successful `--json` result: one JSON document on stdout. */
export function jsonResult(value: unknown): RunResult {
  return ok(`${JSON.stringify(toJsonSafe(value), null, 2)}\n`);
}

/**
 * Failure output. With `--json` the error goes to stdout as a JSON object so a
 * script can parse it; otherwise it goes to stderr as one line plus a hint.
 */
export function fail(
  exitCode: ExitCode,
  code: string,
  message: string,
  json: boolean,
  detail: Record<string, unknown> = {},
): RunResult {
  if (json) {
    const body = { error: { code, message, ...detail } };
    return { exitCode, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: "" };
  }
  const hint = typeof detail["hint"] === "string" ? `hint: ${detail["hint"]}\n` : "";
  return {
    exitCode,
    stdout: "",
    stderr: `skn: ${message}\n${hint || "Run 'skn --help' for usage.\n"}`,
  };
}

export function usage(message: string, json: boolean): RunResult {
  return fail(EXIT.usage, "USAGE_ERROR", message, json);
}
