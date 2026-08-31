// Minimal provider giving hooks access to a shared `KeeperRegistryClient`
// instance without each one constructing its own. Scoped to just what
// `useTask`/`useTaskEvents` need for this epic's assigned issues — the full
// backlog 0173 (`useKeeperRegistryClient`, peer-dependency split docs) is
// its own issue; this is deliberately the minimal slice this epic's other
// hooks can build on without blocking on 0173 landing first.

import { createContext, type ReactNode, useContext } from "react";

import type { KeeperRegistryClient } from "../client";

const KeeperRegistryContext = createContext<KeeperRegistryClient | undefined>(undefined);

export interface KeeperRegistryProviderProps {
  client: KeeperRegistryClient;
  children: ReactNode;
}

export function KeeperRegistryProvider({ client, children }: KeeperRegistryProviderProps) {
  return <KeeperRegistryContext.Provider value={client}>{children}</KeeperRegistryContext.Provider>;
}

/** Throws a clear, actionable error if called outside {@link KeeperRegistryProvider} rather than letting `undefined` propagate silently into a later crash. */
export function useKeeperRegistryClient(): KeeperRegistryClient {
  const client = useContext(KeeperRegistryContext);
  if (!client) {
    throw new Error("useKeeperRegistryClient() must be called within a <KeeperRegistryProvider>.");
  }
  return client;
}
