import {
  KeeperContractError,
  KeeperRpcError,
} from "@soroban-keeper-network/sdk";

/**
 * Process exit codes. A script can branch on these without parsing text:
 * `2` means the command line was wrong, `3` that the contract refused the
 * call, `4` that the network or RPC failed before the contract gave a verdict.
 */
export const ExitCode = {
  Ok: 0,
  Failure: 1,
  Usage: 2,
  Contract: 3,
  Rpc: 4,
} as const;

/** An error with a stable machine-readable `code` and a process exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = ExitCode.Failure,
    readonly code: string = "error",
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A bad flag, argument or missing input: the caller can fix it and retry. */
export function usageError(message: string): CliError {
  return new CliError(message, ExitCode.Usage, "usage");
}

/**
 * Normalises anything thrown into a {@link CliError}, scrubbing every value in
 * `secrets` from the message first. Keys are never meant to reach an error
 * string, but an upstream message that echoed one must not reach a terminal or
 * a log either.
 */
export function toCliError(error: unknown, secrets: readonly string[] = []): CliError {
  const scrub = (text: string): string =>
    secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), text);

  if (error instanceof CliError) {
    return new CliError(scrub(error.message), error.exitCode, error.code);
  }
  if (error instanceof KeeperContractError) {
    return new CliError(scrub(error.message), ExitCode.Contract, error.codeName);
  }
  if (error instanceof KeeperRpcError) {
    return new CliError(scrub(error.message), ExitCode.Rpc, "rpc_error");
  }
  if (error instanceof Error) {
    return new CliError(scrub(error.message), ExitCode.Failure, "error");
  }
  return new CliError(scrub(String(error)), ExitCode.Failure, "error");
}
