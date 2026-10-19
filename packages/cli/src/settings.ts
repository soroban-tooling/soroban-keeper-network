import {
  NETWORK_NAMES,
  NETWORK_PRESETS,
  isNetworkName,
  type NetworkName,
} from "@soroban-keeper-network/sdk";
import type { ConfigFile } from "./config.js";

/** Flags that select or override settings. Every command accepts these. */
export interface SettingFlags {
  network?: string | undefined;
  rpcUrl?: string | undefined;
  contractId?: string | undefined;
  profile?: string | undefined;
  confirmMainnet?: boolean | undefined;
}

export interface Settings {
  profile: string | undefined;
  network: NetworkName;
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string | undefined;
  confirmMainnet: boolean;
}

export class SettingsError extends Error {}

/**
 * Resolves the effective settings. Precedence: flag, then the selected
 * profile, then the built-in default (testnet). The profile is `--profile` if
 * given, otherwise the config's `defaultProfile`.
 */
export function resolveSettings(
  flags: SettingFlags,
  config: ConfigFile | undefined,
): Settings {
  let profileName: string | undefined;
  let profileNetwork: NetworkName | undefined;
  let profileContract: string | undefined;

  if (flags.profile !== undefined) {
    if (config === undefined) {
      throw new SettingsError(`--profile ${flags.profile} needs a config file; run 'skn config init'`);
    }
    const profile = config.profiles[flags.profile];
    if (profile === undefined) {
      throw new SettingsError(`no profile named '${flags.profile}' in the config file`);
    }
    profileName = flags.profile;
    profileNetwork = profile.network;
    profileContract = profile.contractId;
  } else if (config !== undefined) {
    profileName = config.defaultProfile;
    const profile = config.profiles[config.defaultProfile];
    profileNetwork = profile?.network;
    profileContract = profile?.contractId;
  }

  let network: NetworkName;
  if (flags.network !== undefined) {
    if (!isNetworkName(flags.network)) {
      throw new SettingsError(
        `unknown network '${flags.network}'; expected one of ${NETWORK_NAMES.join(", ")}`,
      );
    }
    network = flags.network;
  } else {
    network = profileNetwork ?? "testnet";
  }

  const preset = NETWORK_PRESETS[network];
  return {
    profile: profileName,
    network,
    rpcUrl: flags.rpcUrl ?? preset.rpcUrl,
    networkPassphrase: preset.networkPassphrase,
    contractId: flags.contractId ?? profileContract,
    confirmMainnet: flags.confirmMainnet === true,
  };
}

/**
 * Guard for a command that sends a transaction. On mainnet it refuses to run
 * without `--confirm-mainnet`, so a script cannot spend real funds by accident.
 * Call it before any state-changing submission.
 */
export function requireMainnetConfirmation(settings: Settings): void {
  if (settings.network === "mainnet" && !settings.confirmMainnet) {
    throw new SettingsError(
      "this command sends a transaction on mainnet; pass --confirm-mainnet to proceed",
    );
  }
}
