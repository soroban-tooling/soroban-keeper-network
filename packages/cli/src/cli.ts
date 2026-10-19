import { KeeperContractError, KeeperRpcError, KeeperSdkError } from "@soroban-keeper-network/sdk";
import { Command, CommanderError } from "commander";

import { CliError, ExitCode } from "./cliError.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerTaskCommands } from "./commands/task/index.js";
import { createContext, SecretRedactor, type CliIo, type CommandContext } from "./context.js";
import { CONFIG_ENV } from "./config.js";
import { isSecretSeed, SECRET_KEY_ENV } from "./keys.js";
import { versionText } from "./version.js";

/**
 * Command groups from the CLI scope (backlog 0450) that have no subcommands
 * yet. Listed so `skn --help` shows the whole tree; each is filled in by its
 * own issue.
 */
const PLANNED_GROUPS: readonly [name: string, description: string][] = [
  ["keeper", "keeper balances and reward withdrawals"],
  ["admin", "contract administration (pause, fees, minimum reward)"],
  ["batch", "register many tasks from one file"],
  ["deploy", "deploy the registry and treasury contracts"],
  ["events", "watch contract events"],
];

/** Builds the `skn` command tree, writing through `ctx`. */
export function buildProgram(ctx: CommandContext): Command {
  const program = new Command("skn")
    .description("Command-line tool for the Soroban Keeper Network.")
    .version(versionText(), "-V, --version", "print the CLI version and the contract versions it supports")
    .option("--profile <name>", "network profile from the config file")
    .option("--config <path>", `config file (default: $${CONFIG_ENV}, else the user config directory)`)
    .option("--rpc-url <url>", "Soroban RPC URL; overrides the profile")
    .option("--network-passphrase <passphrase>", "network passphrase; overrides the profile")
    .option("--contract-id <id>", "keeper-registry contract ID (C...); overrides the profile")
    .option("--key-file <path>", "read the signing key from a file only your user can access")
    .option("--identity <name>", "sign with a Stellar CLI identity")
    .option("--confirm-mainnet", "required by commands that send a transaction to mainnet")
    .addHelpText(
      "after",
      `\nSigning keys come from --key-file, then --identity, then $${SECRET_KEY_ENV}.` +
        "\nSecrets are never accepted as command-line arguments.",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.io.stdout(ctx.redactor.redact(text)),
      writeErr: (text) => ctx.io.stderr(ctx.redactor.redact(text)),
    });

  registerTaskCommands(program, ctx);
  registerConfigCommands(program, ctx);
  for (const [name, description] of PLANNED_GROUPS) {
    program
      .command(name)
      .description(`${description} (not implemented yet)`)
      .action(() => {
        throw new CliError(`\`skn ${name}\` has no subcommands yet.`);
      });
  }
  return program;
}

/**
 * Runs one `skn` invocation and resolves to its exit code. Never throws and
 * never calls `process.exit`, so tests can drive it in-process.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const redactor = new SecretRedactor();
  const envSecret = io.env[SECRET_KEY_ENV];
  if (envSecret) redactor.add(envSecret);
  const ctx = createContext(io, redactor);

  // Refuse a secret passed as an argument before the parser can echo it back
  // in an "unknown option" or "too many arguments" message.
  const leaked = argv.map(argumentValue).find(isSecretSeed);
  if (leaked !== undefined) {
    redactor.add(leaked);
    ctx.err(
      "error: a command-line argument looks like a Stellar secret key. Secrets are never accepted " +
        "as arguments, because they end up in shell history and process listings. Use " +
        `${SECRET_KEY_ENV}, --key-file or --identity instead. The value has not been printed.`,
    );
    return ExitCode.Usage;
  }

  try {
    await buildProgram(ctx).parseAsync([...argv], { from: "user" });
    return ExitCode.Ok;
  } catch (error) {
    return report(error, ctx);
  }
}

/** `--flag=value` contributes its value; anything else is checked whole. */
function argumentValue(arg: string): string {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  return eq === -1 ? arg : arg.slice(eq + 1);
}

function report(error: unknown, ctx: CommandContext): number {
  // Commander has already printed its own message (or the help/version text).
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
  }

  const message = error instanceof Error ? error.message : String(error);
  ctx.err(`error: ${message}`);

  if (error instanceof CliError) return error.exitCode;
  if (error instanceof KeeperContractError) return ExitCode.Contract;
  if (error instanceof KeeperRpcError) return ExitCode.Rpc;
  // Remaining SDK errors are its local argument checks: nothing was sent.
  if (error instanceof KeeperSdkError) return ExitCode.Usage;
  return ExitCode.Failure;
}
