/**
 * Named network profiles (`skn config init`, `--profile`).
 *
 * Effective values are layered, highest precedence first:
 *
 * 1. command-line flags (`--rpc-url`, `--network-passphrase`, `--contract-id`);
 * 2. the selected profile in the config file;
 * 3. defaults: the SDK's `NETWORK_PRESETS` entry for the profile's `network`
 *    (or for the profile's own name, when that is a preset name), else testnet.
 *
 * The config file never holds key material, so it needs no special
 * permissions. Keys come from `keys.ts`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  NETWORK_NAMES,
  NETWORK_PRESETS,
  isNetworkName,
  type NetworkName,
} from "@soroban-keeper-network/sdk";

import { CliError } from "./cliError.js";
import type { CliIo } from "./context.js";

/** Environment variable naming the config file, below `--config`. */
export const CONFIG_ENV = "SKN_CONFIG";

/** Profile used when neither `--profile` nor the file's `defaultProfile` picks one. */
export const DEFAULT_PROFILE = "testnet";

export interface ProfileConfig {
  /** Which `NETWORK_PRESETS` entry supplies defaults for unset fields. */
  network?: NetworkName;
  rpcUrl?: string;
  networkPassphrase?: string;
  /** `C...` address of the keeper-registry contract. */
  contractId?: string;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

/** The connection-related global flags. */
export interface ConnectionFlags {
  profile?: string | undefined;
  config?: string | undefined;
  rpcUrl?: string | undefined;
  networkPassphrase?: string | undefined;
  contractId?: string | undefined;
}

/** One effective value and where it came from, for `skn config show`. */
export interface Setting<T extends string | undefined = string> {
  value: T;
  source: string;
}

export interface EffectiveConfig {
  profile: string;
  profileSource: string;
  configPath: string;
  configFileFound: boolean;
  rpcUrl: Setting;
  networkPassphrase: Setting;
  contractId: Setting<string | undefined>;
  /** Decided by passphrase, not profile name: a profile called "prod" can still be mainnet. */
  isMainnet: boolean;
}

const PROFILE_KEYS: readonly (keyof ProfileConfig)[] = [
  "network",
  "rpcUrl",
  "networkPassphrase",
  "contractId",
];

/** `--config`, else `$SKN_CONFIG`, else the per-user config directory. */
export function configPath(flags: ConnectionFlags, io: CliIo): string {
  if (flags.config) return flags.config;
  const fromEnv = io.env[CONFIG_ENV];
  if (fromEnv) return fromEnv;
  if (io.platform === "win32" && io.env.APPDATA) {
    return join(io.env.APPDATA, "skn", "config.json");
  }
  return join(io.env.XDG_CONFIG_HOME || join(io.homedir, ".config"), "skn", "config.json");
}

/** The config `skn config init` writes, and the one in effect when no file exists. */
export function builtInConfig(): ConfigFile {
  const profiles: Record<string, ProfileConfig> = {};
  for (const network of NETWORK_NAMES) {
    const preset = NETWORK_PRESETS[network];
    profiles[network] = {
      network,
      rpcUrl: preset.rpcUrl,
      networkPassphrase: preset.networkPassphrase,
    };
  }
  return { defaultProfile: DEFAULT_PROFILE, profiles };
}

/** Parses and validates a config file's contents. */
export function parseConfig(text: string, path: string): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CliError(`Config file ${path} is not valid JSON: ${(error as Error).message}`);
  }

  const fail = (problem: string): never => {
    throw new CliError(`Config file ${path} is invalid: ${problem}`);
  };

  if (!isPlainObject(raw)) return fail("expected a JSON object.");
  for (const key of Object.keys(raw)) {
    if (key !== "defaultProfile" && key !== "profiles") fail(`unknown top-level key "${key}".`);
  }
  if (!isPlainObject(raw.profiles)) return fail(`"profiles" must be an object.`);

  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, value] of Object.entries(raw.profiles)) {
    if (!isPlainObject(value)) return fail(`profile "${name}" must be an object.`);
    const profile: ProfileConfig = {};
    for (const [key, field] of Object.entries(value)) {
      if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
        fail(`profile "${name}" has unknown key "${key}" (expected ${PROFILE_KEYS.join(", ")}).`);
      }
      if (typeof field !== "string") fail(`profile "${name}": "${key}" must be a string.`);
      const text = field as string;
      if (key === "network") {
        if (!isNetworkName(text)) {
          fail(`profile "${name}": "network" must be one of ${NETWORK_NAMES.join(", ")}.`);
        }
        profile.network = text as NetworkName;
      } else if (text !== "") {
        profile[key as Exclude<keyof ProfileConfig, "network">] = text;
      }
    }
    profiles[name] = profile;
  }

  const config: ConfigFile = { profiles };
  if (raw.defaultProfile !== undefined) {
    if (typeof raw.defaultProfile !== "string") return fail(`"defaultProfile" must be a string.`);
    if (!(raw.defaultProfile in profiles)) {
      fail(`"defaultProfile" names "${raw.defaultProfile}", which is not in "profiles".`);
    }
    config.defaultProfile = raw.defaultProfile;
  }
  return config;
}

/** Reads the config file, or `undefined` when there is none. */
export async function loadConfigFile(path: string): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  return parseConfig(text, path);
}

/** Applies the flag > profile > default layering described at the top of this file. */
export async function resolveConfig(flags: ConnectionFlags, io: CliIo): Promise<EffectiveConfig> {
  const path = configPath(flags, io);
  const file = await loadConfigFile(path);
  const config = file ?? builtInConfig();

  let profile: string;
  let profileSource: string;
  if (flags.profile) {
    profile = flags.profile;
    profileSource = "--profile";
  } else if (config.defaultProfile) {
    profile = config.defaultProfile;
    profileSource = file ? "defaultProfile in config file" : "built-in default";
  } else {
    profile = DEFAULT_PROFILE;
    profileSource = "built-in default";
  }

  const entry = config.profiles[profile];
  if (entry === undefined) {
    const available = Object.keys(config.profiles).join(", ") || "(none)";
    const hint = file ? "" : ` No config file exists at ${path}; run \`skn config init\` to create one.`;
    throw new CliError(`Unknown profile "${profile}". Available profiles: ${available}.${hint}`);
  }

  const network: NetworkName =
    entry.network ?? (isNetworkName(profile) ? profile : DEFAULT_PROFILE);
  const preset = NETWORK_PRESETS[network];
  const fromProfile = `profile "${profile}"`;
  const fromDefault = `default (${network} preset)`;

  const pick = (flag: string | undefined, own: string | undefined, fallback: string): Setting => {
    if (flag) return { value: flag, source: "flag" };
    if (own) return { value: own, source: fromProfile };
    return { value: fallback, source: fromDefault };
  };

  const rpcUrl = pick(flags.rpcUrl, entry.rpcUrl, preset.rpcUrl);
  const networkPassphrase = pick(
    flags.networkPassphrase,
    entry.networkPassphrase,
    preset.networkPassphrase,
  );
  const contractId: Setting<string | undefined> = flags.contractId
    ? { value: flags.contractId, source: "flag" }
    : entry.contractId
      ? { value: entry.contractId, source: fromProfile }
      : { value: undefined, source: "not set" };

  return {
    profile,
    profileSource,
    configPath: path,
    configFileFound: file !== undefined,
    rpcUrl,
    networkPassphrase,
    contractId,
    isMainnet: networkPassphrase.value === NETWORK_PRESETS.mainnet.networkPassphrase,
  };
}

/**
 * Refuses a transaction-sending command on mainnet unless `--confirm-mainnet`
 * was given. Checked before any key is loaded or any transaction built.
 */
export function requireMainnetConfirmation(config: EffectiveConfig, confirmed: boolean): void {
  if (config.isMainnet && !confirmed) {
    throw new CliError(
      `This command sends a transaction to mainnet (profile "${config.profile}"). ` +
        `Re-run with --confirm-mainnet to proceed.`,
    );
  }
}

/** The contract ID, or a usage error explaining where to set one. */
export function requireContractId(config: EffectiveConfig): string {
  if (config.contractId.value) return config.contractId.value;
  throw new CliError(
    `No keeper-registry contract ID is configured for profile "${config.profile}". ` +
      `Pass --contract-id <C...>, or set "contractId" for this profile in ${config.configPath}.`,
  );
}

/** Writes the built-in profiles to `path`. Refuses to overwrite unless `force`. */
export async function writeInitialConfig(path: string, force: boolean): Promise<ConfigFile> {
  const config = builtInConfig();
  await mkdir(dirname(path), { recursive: true });
  try {
    // `wx` makes "does it exist?" and "create it" one atomic step.
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`Config file ${path} already exists. Re-run with --force to overwrite it.`);
    }
    throw new CliError(`Cannot write config file ${path}: ${(error as Error).message}`);
  }
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
