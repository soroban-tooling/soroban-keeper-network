import { homedir } from "node:os";
import {
  KeeperContractError,
  KeeperRpcError,
  SUPPORTED_CONTRACT_VERSIONS,
  type RpcServerLike,
} from "@soroban-keeper-network/sdk";
import { ConfigError, configPath } from "./config.js";
import { type CommandContext } from "./args.js";
import { runConfigInit, runConfigShow } from "./commands/config.js";
import { runInspectVersion } from "./commands/inspect.js";
import { EXIT } from "./exitCodes.js";
import { KeyError } from "./keys.js";
import { fail, ok, usage, type RunResult } from "./output.js";
import { SettingsError } from "./settings.js";
import { CLI_VERSION } from "./version.js";

export type { RunResult } from "./output.js";

export interface RunOptions {
  /**
   * RPC server to use instead of connecting to `--rpc-url`. Tests inject the
   * SDK's fake RPC through this seam; the bin never sets it.
   */
  server?: RpcServerLike | undefined;
  /** Environment for `SKN_CONFIG` and `SKN_SECRET_KEY`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Home directory for the config file and Stellar identities. Defaults to the OS home. */
  homeDir?: string | undefined;
  /** Platform for the key-file permission check. Defaults to `process.platform`. */
  platform?: NodeJS.Platform | undefined;
}

/** Command groups from `docs/CLI_DESIGN.md`. Each one appears in help, implemented or not. */
export const COMMAND_GROUPS = [
  "config",
  "task",
  "keeper",
  "admin",
  "batch",
  "deploy",
  "events",
  "inspect",
] as const;

export const HELP_TEXT = `skn ${CLI_VERSION}: command-line tool for the Soroban Keeper Network

Usage:
  skn <group> <command> [flags]
  skn --help | --version

Command groups:
  config    init | show: manage the config file and named profiles
  task      register, show, list, claim and execute tasks (not implemented yet)
  keeper    keeper balance and withdrawal (not implemented yet)
  admin     admin controls (not implemented yet)
  batch     batch task registration (not implemented yet)
  deploy    deploy the registry and treasury contracts (not implemented yet)
  events    watch contract events (not implemented yet)
  inspect   version: print the contract's VERSION and whether this CLI supports it

Global flags (accepted by every command):
  --profile <name>                       named profile from the config file
  --network <testnet|futurenet|mainnet>  network preset (default: the profile's, else testnet)
  --rpc-url <url>                        override the preset's RPC URL
  --contract-id <id>                     keeper-registry contract ID
  --key-file <path>                      read the signing key from a file (must not be readable by others)
  --identity <name>                      read the signing key from a Stellar CLI identity
  --confirm-mainnet                      required to send a transaction on mainnet
  --json                                 print machine-readable JSON

Signing key precedence: --key-file, then --identity, then SKN_SECRET_KEY.
Config file: SKN_CONFIG, or ~/.config/skn/skn.config.json.

Exit codes:
  0 success     1 internal error   2 usage error
  3 RPC error   4 contract error   5 not found
`;

/**
 * Runs `skn` with the given arguments (without the node and script path) and
 * returns what it would print and the exit code. Never throws and never calls
 * `process.exit`, so the bin and the tests share one code path.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const json = argv.includes("--json");
  const [first, second] = argv;

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    return ok(HELP_TEXT);
  }
  if (first === "--version" || first === "-v") {
    const { min, max } = SUPPORTED_CONTRACT_VERSIONS;
    return ok(`skn ${CLI_VERSION}\nsupported contract VERSION: ${min} to ${max}\n`);
  }
  if (!isCommandGroup(first)) {
    return usage(`unknown command '${first}'`, json);
  }

  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const context: CommandContext = {
    server: options.server,
    env,
    homeDir,
    platform: options.platform ?? process.platform,
    configFile: configPath(env, homeDir),
  };
  const rest = argv.slice(2);

  try {
    if (first === "config" && second === "init") return await runConfigInit(rest, context);
    if (first === "config" && second === "show") return await runConfigShow(rest, context);
    if (first === "inspect" && second === "version") return await runInspectVersion(rest, context);
  } catch (err) {
    return commandError(err, json);
  }

  if (second === undefined || second.startsWith("-")) {
    return usage(`'skn ${first}' needs a command`, json);
  }
  return usage(`'skn ${first} ${second}' is not implemented yet`, json);
}

function isCommandGroup(value: string): value is (typeof COMMAND_GROUPS)[number] {
  return (COMMAND_GROUPS as readonly string[]).includes(value);
}

/**
 * The one place an error becomes an exit code. Usage, config, settings and key
 * problems are user input (code 2). RPC and contract errors keep their own codes.
 */
export function commandError(err: unknown, json: boolean): RunResult {
  if (err instanceof KeeperRpcError) {
    return fail(EXIT.rpc, "RPC_ERROR", err.message, json);
  }
  if (err instanceof KeeperContractError) {
    return fail(EXIT.contract, "CONTRACT_ERROR", err.message, json);
  }
  if (err instanceof ConfigError || err instanceof SettingsError || err instanceof KeyError) {
    return usage(err.message, json);
  }
  if (isParseError(err)) {
    return usage(err.message, json);
  }
  return fail(EXIT.internal, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err), json);
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
