import type { Command } from "commander";

import { configPath, resolveConfig, writeInitialConfig } from "../config.js";
import type { CommandContext } from "../context.js";
import { writeResult } from "../output.js";
import type { GlobalOptions } from "../session.js";

export function registerConfigCommands(program: Command, ctx: CommandContext): void {
  const config = program
    .command("config")
    .description("create and inspect the config file and its network profiles");

  config
    .command("init")
    .description("write a config file with testnet, futurenet and mainnet profiles")
    .option("--force", "overwrite an existing config file")
    .action(async (options: { force?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const path = configPath(globals, ctx.io);
      const written = await writeInitialConfig(path, options.force === true);
      const profiles = Object.keys(written.profiles);
      writeResult(ctx, globals.json === true, {
        lines: [
          `Wrote ${path}`,
          `Profiles: ${profiles.join(", ")} (default: ${written.defaultProfile})`,
          `Set "contractId" in a profile, or pass --contract-id, before running task commands.`,
        ],
        data: { path, profiles, defaultProfile: written.defaultProfile },
      });
    });

  config
    .command("show")
    .description("print the effective settings after applying flags, profile and defaults")
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      const effective = await resolveConfig(globals, ctx.io);
      const file = effective.configFileFound
        ? effective.configPath
        : `${effective.configPath} (not found; using built-in profiles)`;
      const rows: [string, string][] = [
        ["Config file", file],
        ["Profile", `${effective.profile} [${effective.profileSource}]`],
        ["RPC URL", `${effective.rpcUrl.value} [${effective.rpcUrl.source}]`],
        [
          "Network passphrase",
          `${effective.networkPassphrase.value} [${effective.networkPassphrase.source}]`,
        ],
        [
          "Contract ID",
          effective.contractId.value === undefined
            ? "(not set; pass --contract-id or set contractId in the profile)"
            : `${effective.contractId.value} [${effective.contractId.source}]`,
        ],
        [
          "Mainnet",
          effective.isMainnet ? "yes (transactions require --confirm-mainnet)" : "no",
        ],
      ];
      const width = Math.max(...rows.map(([label]) => label.length));
      const lines = rows.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${value}`);
      writeResult(ctx, globals.json === true, {
        lines,
        data: {
          configPath: effective.configPath,
          configFileFound: effective.configFileFound,
          profile: effective.profile,
          profileSource: effective.profileSource,
          rpcUrl: effective.rpcUrl.value,
          rpcUrlSource: effective.rpcUrl.source,
          networkPassphrase: effective.networkPassphrase.value,
          networkPassphraseSource: effective.networkPassphrase.source,
          contractId: effective.contractId.value ?? null,
          contractIdSource: effective.contractId.source,
          isMainnet: effective.isMainnet,
        },
      });
    });
}
