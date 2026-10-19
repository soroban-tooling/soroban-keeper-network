import { ExitCode } from "./cliError.js";
import type { CommandContext } from "./context.js";

/**
 * One command result, rendered two ways: `lines` for people, `data` for
 * scripts. Both describe the same outcome, so a script and a person reading
 * the same run see the same facts.
 */
export interface CommandOutput {
  lines: string[];
  data: Record<string, unknown>;
}

/** The `kind` a script can branch on, one per exit code. */
const ERROR_KINDS: Record<number, string> = {
  [ExitCode.Failure]: "failure",
  [ExitCode.Usage]: "usage",
  [ExitCode.Contract]: "contract",
  [ExitCode.Rpc]: "rpc",
};

/**
 * JSON with every bigint as its decimal string, so u64 and i128 values keep
 * their full precision. A JavaScript number would silently round them.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

/** Writes a successful result to stdout: the text lines, or one JSON object. */
export function writeResult(ctx: CommandContext, json: boolean, output: CommandOutput): void {
  if (json) {
    ctx.out(toJson({ ok: true, ...output.data }));
    return;
  }
  for (const line of output.lines) ctx.out(line);
}

/**
 * Writes a failure. In JSON mode the error is a JSON object on stdout, so a
 * script reads one stream and branches on the exit code or `error.kind`.
 */
export function writeError(
  ctx: CommandContext,
  json: boolean,
  message: string,
  exitCode: number,
): void {
  if (json) {
    const kind = ERROR_KINDS[exitCode] ?? "failure";
    ctx.out(toJson({ ok: false, error: { kind, exitCode, message } }));
    return;
  }
  ctx.err(`error: ${message}`);
}
