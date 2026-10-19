import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNetworkName, type NetworkName } from "@soroban-keeper-network/sdk";

/** One named profile. Profiles never hold secrets; keys come from `keys.ts`. */
export interface Profile {
  network: NetworkName;
  contractId?: string;
}

export interface ConfigFile {
  defaultProfile: string;
  profiles: Record<string, Profile>;
}

/** The file `skn config init` writes: one profile per network preset. */
export function defaultConfig(): ConfigFile {
  return {
    defaultProfile: "testnet",
    profiles: {
      testnet: { network: "testnet" },
      futurenet: { network: "futurenet" },
      mainnet: { network: "mainnet" },
    },
  };
}

export class ConfigError extends Error {}

/**
 * Where the config file lives: `SKN_CONFIG` if set, otherwise
 * `~/.config/skn/skn.config.json` under `homeDir`.
 */
export function configPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env["SKN_CONFIG"] ?? join(homeDir, ".config", "skn", "skn.config.json");
}

/**
 * Reads and validates the config file. Returns `undefined` when there is no
 * file, so commands can run on flags and defaults alone. A file that exists
 * but is malformed is an error, never silently ignored.
 */
export async function readConfig(path: string): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`cannot read config file ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`config file ${path} is not valid JSON`);
  }
  return validateConfig(parsed, path);
}

function validateConfig(value: unknown, path: string): ConfigFile {
  const fail = (detail: string): never => {
    throw new ConfigError(`config file ${path}: ${detail}`);
  };
  if (value === null || typeof value !== "object") fail("expected a JSON object");

  const { defaultProfile, profiles } = value as Record<string, unknown>;
  if (typeof defaultProfile !== "string") fail("'defaultProfile' must be a string");
  if (profiles === null || typeof profiles !== "object") fail("'profiles' must be an object");

  const checked: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(profiles as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") fail(`profile '${name}' must be an object`);
    const { network, contractId } = raw as Record<string, unknown>;
    if (typeof network !== "string" || !isNetworkName(network)) {
      fail(`profile '${name}' has an unknown network`);
    }
    if (contractId !== undefined && typeof contractId !== "string") {
      fail(`profile '${name}' has a non-string contractId`);
    }
    const profile: Profile = { network: network as NetworkName };
    if (contractId !== undefined) profile.contractId = contractId as string;
    checked[name] = profile;
  }
  if (!(defaultProfile as string in checked)) {
    fail(`defaultProfile '${defaultProfile}' is not one of its profiles`);
  }
  return { defaultProfile: defaultProfile as string, profiles: checked };
}

/** Writes the config. Refuses to overwrite an existing file unless `force` is set. */
export async function writeConfig(
  path: string,
  config: ConfigFile,
  force: boolean,
): Promise<void> {
  if (!force && (await exists(path))) {
    throw new ConfigError(`${path} already exists; pass --force to overwrite it`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

