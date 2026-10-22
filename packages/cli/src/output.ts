import type { CliError } from "./errors.js";
import type { CliIo } from "./runtime.js";

/** `JSON.stringify` that renders `bigint` as a decimal string, as the indexer does for `i128`. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Human and `--json` output behind one interface.
 *
 * Results go to stdout; everything a person might want but a pipe must not
 * receive (fee previews, warnings, errors) goes to stderr. In `--json` mode
 * stdout carries exactly one JSON document per result (one per line for a
 * stream), and stderr carries one JSON error object on failure.
 */
export class Output {
  constructor(
    private readonly io: CliIo,
    readonly json: boolean,
  ) {}

  /** A command's result: `data` as one JSON line, or `human` text. */
  result(data: unknown, human: string): void {
    this.io.stdout(`${this.json ? toJson(data) : human}\n`);
  }

  /** A line for a person only: suppressed entirely under `--json`. */
  note(message: string): void {
    if (!this.json) this.io.stderr(`${message}\n`);
  }

  /** A warning: plain text for a person, a JSON object under `--json`. */
  warn(message: string): void {
    this.io.stderr(`${this.json ? toJson({ warning: message }) : `warning: ${message}`}\n`);
  }

  error(error: CliError): void {
    if (this.json) {
      this.io.stderr(
        `${toJson({ error: { code: error.code, message: error.message, exitCode: error.exitCode } })}\n`,
      );
    } else {
      this.io.stderr(`error[${error.code}]: ${error.message}\n`);
    }
  }
}

/** Renders stroops as XLM with the 7 decimal places Stellar uses. */
export function formatStroops(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0");
  return `${stroops} stroops (${whole}.${fraction} XLM)`;
}
