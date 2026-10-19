import type { Command } from "commander";

import { configPath, resolveConfig, writeInitialConfig } from "../config.js";
import type { CommandContext } from "../context.js";
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
      const path = configPath(command.optsWithGlobals<GlobalOptions>(), ctx.io);
      const written = await writeInitialConfig(path, options.force === true);
      ctx.out(`Wrote ${path}`);
      ctx.out(`Profiles: ${Object.keys(written.profiles).join(", ")} (default: ${written.defaultProfile})`);
      ctx.out(`Set "contractId" in a profile, or pass --contract-id, before running task commands.`);
    });

  config
    .command("show")
    .description("print the effective settings after applying flags, profile and defaults")
    .action(async (_options: unknown, command: Command) => {
      const effective = await resolveConfig(command.optsWithGlobals<GlobalOptions>(), ctx.io);
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
      for (const [label, value] of rows) ctx.out(`${`${label}:`.padEnd(width + 2)}${value}`);
    });
}
