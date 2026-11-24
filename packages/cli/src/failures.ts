import {
  KeeperContractError,
  KeeperErrorCode,
  KeeperRpcError,
  KeeperSdkError,
  treasury,
} from "@soroban-keeper-network/sdk";
import { UsageError } from "./args.js";
import { ConfigError } from "./config.js";
import { explainContractError } from "./errors.js";
import { EXIT } from "./exitCodes.js";
import { KeyError } from "./keys.js";
import { fail, usage, type RunResult } from "./output.js";
import { redactSecrets } from "./redact.js";
import { SettingsError } from "./settings.js";

/**
 * The one place an error becomes an exit code. Usage, config, settings and key
 * problems are user input (2). RPC failures are network problems (3). A
 * contract rejection is 4, and TaskNotFound is 5. Contract errors carry the
 * plain-language explanation from errors.ts.
 */
export function commandError(err: unknown, json: boolean): RunResult {
  if (err instanceof KeeperContractError) {
    const help = explainContractError(err.code);
    const detail = { contractError: help.name, errorCode: err.code, hint: help.hint };
    const fullMessage = err.local
      ? `${help.name}: ${help.message} (${err.message})`
      : `${help.name}: ${help.message}`;
    if (err.code === KeeperErrorCode.TaskNotFound) {
      return fail(EXIT.notFound, "NOT_FOUND", redactSecrets(fullMessage), json, detail);
    }
    return fail(EXIT.contract, "CONTRACT_ERROR", redactSecrets(fullMessage), json, detail);
  }
  if (err instanceof treasury.TreasuryContractError) {
    const name = treasury.TreasuryErrorCode[err.code] ?? `TreasuryError(${err.code})`;
    const detail = { contractError: name, errorCode: err.code };
    return fail(EXIT.contract, "CONTRACT_ERROR", redactSecrets(`${name}: ${err.message}`), json, detail);
  }
  if (err instanceof KeeperRpcError || err instanceof treasury.TreasuryRpcError) {
    return fail(EXIT.rpc, "RPC_ERROR", redactSecrets(err.message), json);
  }
  if (
    err instanceof UsageError ||
    err instanceof ConfigError ||
    err instanceof SettingsError ||
    err instanceof KeyError ||
    err instanceof KeeperSdkError ||
    err instanceof treasury.TreasurySdkError
  ) {
    return usage(redactSecrets(err.message), json);
  }
  if (isParseError(err)) {
    return usage(redactSecrets(err.message), json);
  }
  return fail(
    EXIT.internal,
    "INTERNAL_ERROR",
    redactSecrets(err instanceof Error ? err.message : String(err)),
    json,
  );
}

const PARSE_ERROR_CODES = new Set([
  "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
]);

/** Node's `parseArgs` reports unknown or malformed flags with one of these codes. */
function isParseError(err: unknown): err is Error {
  return err instanceof Error && PARSE_ERROR_CODES.has((err as { code?: string }).code ?? "");
}
