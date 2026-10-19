/**
 * Process exit codes. A script can tell "I called it wrong" from "the
 * contract said no" from "the network failed", and only the last is worth
 * retrying unchanged.
 */
export const ExitCode = {
  Ok: 0,
  /** Anything not classified below. */
  Failure: 1,
  /** Bad arguments, configuration or key material. Nothing was sent. */
  Usage: 2,
  /** The contract rejected the call (a `KeeperErrorCode`), or a routine claim/execute rejection. */
  Contract: 3,
  /** The call never reached a contract verdict: transport failure, malformed response. */
  Rpc: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An error whose message is written for the operator, printed as-is with no
 * stack trace. Messages must never contain key material; see `keys.ts`.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.Usage,
  ) {
    super(message);
    this.name = "CliError";
  }
}
