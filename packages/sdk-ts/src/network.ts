import { Networks } from "@stellar/stellar-sdk";

/**
 * Network presets for the Soroban Keeper Network.
 *
 * Modeled directly on `examples/keeper-bot/index.js`'s `NETWORK_CONFIG`
 * object (issue 0189 in the SDK epic) — that bot's hand-rolled table is the
 * reference this type and its values are lifted from verbatim, so migrating
 * the bot onto this export is a like-for-like swap, not a behavior change.
 */
export type NetworkName = "testnet" | "futurenet" | "mainnet";

export interface NetworkPreset {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
}

export const NETWORK_PRESETS: Readonly<Record<NetworkName, NetworkPreset>> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  futurenet: {
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
  },
  mainnet: {
    rpcUrl: "https://mainnet.sorobanrpc.com",
    networkPassphrase: Networks.PUBLIC,
  },
};

/** All valid network names, for validating user-supplied config. */
export const NETWORK_NAMES: readonly NetworkName[] = Object.keys(
  NETWORK_PRESETS,
) as NetworkName[];

export function isNetworkName(value: string): value is NetworkName {
  return (NETWORK_NAMES as readonly string[]).includes(value);
}
