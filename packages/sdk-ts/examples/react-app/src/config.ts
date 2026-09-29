import { Keypair } from "@stellar/stellar-sdk";
import { isNetworkName, NETWORK_PRESETS } from "@soroban-keeper-network/sdk";

const networkName = import.meta.env.VITE_NETWORK ?? "testnet";
if (!isNetworkName(networkName)) {
  throw new Error(`VITE_NETWORK must be one of testnet/futurenet/mainnet, got ${networkName}`);
}

export const NETWORK_NAME = networkName;
export const NETWORK = NETWORK_PRESETS[networkName];

export const REGISTRY_CONTRACT_ID = import.meta.env.VITE_REGISTRY_CONTRACT_ID;
if (!REGISTRY_CONTRACT_ID) {
  throw new Error("VITE_REGISTRY_CONTRACT_ID is not set — copy .env.example to .env first.");
}

// DEV-ONLY: see .env.example's warning before reusing this pattern anywhere
// that isn't a local demo — Vite inlines this into the built bundle in
// plain text.
export const DEMO_KEYPAIR = Keypair.fromSecret(import.meta.env.VITE_DEMO_SECRET_KEY);
