import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DashboardIndexer } from "./indexer";
import type { RegistryReader } from "./types";

interface DashboardData {
  indexer: DashboardIndexer;
  registry?: RegistryReader;
}

const DataContext = createContext<DashboardData | null>(null);

export function DataProvider({ children, registry }: { children: ReactNode; registry?: RegistryReader }) {
  const indexer = useMemo(
    () => new DashboardIndexer(import.meta.env.VITE_INDEXER_URL ?? "http://localhost:3000/v1"),
    [],
  );
  return <DataContext.Provider value={{ indexer, registry }}>{children}</DataContext.Provider>;
}

export function useDashboardData(): DashboardData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useDashboardData must be used inside DataProvider");
  return value;
}
