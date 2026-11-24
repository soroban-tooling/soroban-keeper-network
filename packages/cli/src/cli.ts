import { homedir } from "node:os";
import { SUPPORTED_CONTRACT_VERSIONS, type RpcServerLike } from "@soroban-keeper-network/sdk";
import { configPath } from "./config.js";
import { type CommandContext } from "./args.js";
import { runAdminCommand } from "./commands/admin/index.js";
import { runBatchRegister } from "./commands/batch/register.js";
import { runConfigInit, runConfigShow } from "./commands/config.js";
import { runDeploy } from "./commands/deploy.js";
import { runInspect, runInspectVersion } from "./commands/inspect.js";
import { runKeeperCommand } from "./commands/keeper/index.js";
import { runTaskCommand } from "./commands/task/index.js";
import type { ConfirmFn } from "./confirm.js";
import { commandError } from "./failures.js";
import { HELP_GROUPS, HELP_TEXT, helpFor, helpPathFromArgs } from "./help.js";
import { ok, usage, type RunResult } from "./output.js";
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
  /** Asks the user to confirm a transaction. The bin provides one when stdin is a terminal. */
  confirm?: ConfirmFn | undefined;
  /** Clock in Unix seconds, for deadline validation. Defaults to the system clock. */
  now?: (() => number) | undefined;
}

export { HELP_TEXT };
/** Command groups, derived from the same data that renders `--help`. */
export const COMMAND_GROUPS: readonly string[] = HELP_GROUPS.map((group) => group.name);

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
  // `skn <group> [command] --help` prints the matching page before any flag
  // parsing or network access. Unknown paths fall through to the normal
  // router, which reports them as usage errors.
  const helpPath = helpPathFromArgs(argv);
  if (helpPath !== undefined) {
    const page = helpFor(helpPath);
    if (page !== undefined) return ok(page);
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

    if (first === "inspect") {
      if (second === undefined || second.startsWith("-")) {
        return await runInspect(argv.slice(1), context);
      }
      if (second === "summary") {
        return await runInspect(rest, context);
      }
      if (second === "version") {
        return await runInspectVersion(rest, context);
      }
      return usage(`unknown inspect command '${second}'; expected summary or version`, json);
    }

    if (first === "admin") {
      return await runAdminCommand(second, rest, context, { confirm: options.confirm });
    }

    if (first === "batch") {
      if (second === "register") {
        return await runBatchRegister(rest, context, { now: options.now });
      }
      if (second === undefined || second.startsWith("-")) {
        return usage("'skn batch' needs a command (for example 'skn batch register <file>')", json);
      }
      return usage(`'skn batch ${second}' is not implemented yet`, json);
    }

    if (first === "task") {
      return await runTaskCommand(second, rest, context);
    }

    if (first === "keeper") {
      return await runKeeperCommand(second, rest, context);
    }

    if (first === "deploy") {
      return await runDeploy(second, rest, context, { confirm: options.confirm });
    }
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
