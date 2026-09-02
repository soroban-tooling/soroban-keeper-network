import React from "react";
import { KeeperRegistryClient } from "../client";
export interface KeeperRegistryProviderProps {
    /**
     * Optional pre-constructed client instance. If provided, configuration props are ignored.
     */
    client?: KeeperRegistryClient;
    /**
     * Smart contract ID string (C...). Required if `client` is not provided.
     */
    contractId?: string;
    /**
     * Soroban RPC URL. Required if `client` is not provided.
     */
    rpcUrl?: string;
    /**
     * Stellar network passphrase. Required if `client` is not provided.
     */
    networkPassphrase?: string;
    /**
     * Optional secret key (S...) for server/testing environments.
     */
    secretKey?: string;
    /**
     * React children components.
     */
    children: React.ReactNode;
}
/**
 * Context Provider that supplies a shared `KeeperRegistryClient` instance to children React components.
 */
export declare const KeeperRegistryProvider: React.FC<KeeperRegistryProviderProps>;
/**
 * Custom hook to retrieve the shared `KeeperRegistryClient` instance from context.
 * Throws a clear, actionable error if called outside `<KeeperRegistryProvider>`.
 */
export declare function useKeeperRegistryClient(): KeeperRegistryClient;
//# sourceMappingURL=provider.d.ts.map