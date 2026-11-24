import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DashboardIndexer } from "./indexer";
import type { RegistryOperations, RegistryReader } from "./types";

interface DashboardData {
  indexer: DashboardIndexer;
  registry?: RegistryReader;
  operations?: RegistryOperations;
  account?: string;
}

const DataContext = createContext<DashboardData | null>(null);

export function DataProvider({ children, registry, operations, account }: { children: ReactNode; registry?: RegistryReader; operations?: RegistryOperations; account?: string }) {
  const indexer = useMemo(
    () => new DashboardIndexer(import.meta.env.VITE_INDEXER_URL ?? "http://localhost:3000/v1"),
    [],
  );
  return <DataContext.Provider value={{ indexer, registry, operations, account }}>{children}</DataContext.Provider>;
}

export function useDashboardData(): DashboardData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useDashboardData must be used inside DataProvider");
  return value;
}
