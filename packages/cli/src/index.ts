import { Command, CommanderError } from "commander";

import { registerAdmin } from "./commands/admin.js";
import { registerEvents } from "./commands/events.js";
import { registerTaskRegister } from "./commands/task/register.js";
import { ExitCode, toCliError } from "./errors.js";
import { Output } from "./output.js";
import type { Runtime } from "./runtime.js";
import { versionText } from "./version.js";

export { CLI_VERSION } from "./version.js";
export type { Runtime } from "./runtime.js";
export { ExitCode } from "./errors.js";

/**
 * Builds the `skn` command tree. Output, exit and every outside dependency go
 * through `rt`, so the same tree runs unchanged under a test.
 */
export function buildProgram(rt: Runtime): Command {
  const program = new Command("skn");

  // Applied before any subcommand is created so each inherits them: output goes
  // through `rt.io`, and a parse error throws instead of calling process.exit.
  program
    .configureOutput({
      writeOut: (text) => rt.io.stdout(text),
      writeErr: (text) => rt.io.stderr(text),
    })
    .exitOverride();

  program
    .description("Soroban Keeper Network command-line tool")
    .version(versionText(), "-v, --version", "print the CLI version and supported contract versions")
    .option("--network <name>", "testnet, futurenet or mainnet (env: SKN_NETWORK, default testnet)")
    .option("--rpc-url <url>", "Soroban RPC endpoint (env: SKN_RPC_URL)")
    .option("--passphrase <text>", "network passphrase (env: SKN_NETWORK_PASSPHRASE)")
    .option("--contract-id <id>", "keeper-registry contract, C... (env: SKN_CONTRACT_ID)")
    .option("--key-file <path>", "file holding the signing secret key (env: SKN_SECRET_KEY)")
    .option("--json", "machine-readable output: one JSON document per result")
    .addHelpText(
      "after",
      "\nExit codes: 0 ok, 1 failure, 2 usage error, 3 contract error, 4 network/RPC error.\n" +
        "Keys are read from SKN_SECRET_KEY or --key-file and are never printed.",
    );

  const task = program.command("task").description("Register and manage tasks");
  registerTaskRegister(task, rt);
  registerAdmin(program, rt);
  registerEvents(program, rt);

  return program;
}

/**
 * Runs the CLI and returns the process exit code. Never throws and never exits
 * the process itself.
 */
export async function run(argv: readonly string[], rt: Runtime): Promise<number> {
  const program = buildProgram(rt);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already written its own message; --help and --version exit 0.
      return error.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
    }
    const cliError = toCliError(error, rt.secrets);
    new Output(rt.io, argv.includes("--json")).error(cliError);
    return cliError.exitCode;
  }
}
