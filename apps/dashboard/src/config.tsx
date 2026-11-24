import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  label: string;
  indexerUrl: string;
  registryContractId: string;
  treasuryContractId?: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export const networks: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    label: "Testnet",
    indexerUrl: import.meta.env.VITE_TESTNET_INDEXER_URL ?? import.meta.env.VITE_INDEXER_URL ?? "http://localhost:3000/v1",
    registryContractId: import.meta.env.VITE_TESTNET_REGISTRY_ID ?? "",
    treasuryContractId: import.meta.env.VITE_TESTNET_TREASURY_ID ?? "",
    rpcUrl: import.meta.env.VITE_TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    name: "mainnet",
    label: "Mainnet",
    indexerUrl: import.meta.env.VITE_MAINNET_INDEXER_URL ?? "",
    registryContractId: import.meta.env.VITE_MAINNET_REGISTRY_ID ?? "",
    treasuryContractId: import.meta.env.VITE_MAINNET_TREASURY_ID ?? "",
    rpcUrl: import.meta.env.VITE_MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
};

interface NetworkState { network: NetworkConfig; selectNetwork: (name: NetworkName) => void }
const NetworkContext = createContext<NetworkState | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const initial = localStorage.getItem("keeper-network") === "mainnet" ? "mainnet" : "testnet";
  const [name, setName] = useState<NetworkName>(initial);
  const value = useMemo(() => ({ network: networks[name], selectNetwork: (next: NetworkName) => { localStorage.setItem("keeper-network", next); setName(next); } }), [name]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkState {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("useNetwork must be used inside NetworkProvider");
  return value;
}
