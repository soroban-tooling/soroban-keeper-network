import { parseArgs } from "node:util";
import type { RpcServerLike } from "@soroban-keeper-network/sdk";
import { readConfig, type ConfigFile } from "./config.js";

/** Everything a command needs besides its own arguments. */
export interface CommandContext {
  server: RpcServerLike | undefined;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  /** Config file path, from `SKN_CONFIG` or the default location. */
  configFile: string;
}

/** Flags every command accepts. Their meaning is in the help text and docs/CLI_DESIGN.md. */
export const GLOBAL_OPTIONS = {
  profile: { type: "string" },
  network: { type: "string" },
  "rpc-url": { type: "string" },
  "contract-id": { type: "string" },
  "key-file": { type: "string" },
  identity: { type: "string" },
  "confirm-mainnet": { type: "boolean" },
  json: { type: "boolean" },
} as const;

export type ParsedValues = Record<string, string | boolean | undefined>;

/**
 * Parses a command's arguments: the global flags plus the command's own. An
 * unknown flag throws Node's parse error, which the router maps to a usage
 * error, so a typo never runs with defaults.
 */
export function parseCommandArgs(
  args: readonly string[],
  own: Record<string, { type: "string" | "boolean" }>,
): { values: ParsedValues; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { ...GLOBAL_OPTIONS, ...own },
    strict: true,
    allowPositionals: true,
  });
  return { values: values as ParsedValues, positionals };
}

/** Loads the config file. `undefined` means there is none, which is fine. */
export function loadConfig(context: CommandContext): Promise<ConfigFile | undefined> {
  return readConfig(context.configFile);
}
