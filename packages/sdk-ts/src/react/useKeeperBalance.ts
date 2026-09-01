import { useCallback } from "react";

import { useKeeperRegistryClient } from "./provider";
import { usePolling } from "./usePolling";

export interface UseKeeperBalanceOptions {
  pollIntervalMs?: number;
}

export interface UseKeeperBalanceResult {
  balance: bigint;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useKeeperBalance(
  address: string,
  options: UseKeeperBalanceOptions = {},
): UseKeeperBalanceResult {
  const client = useKeeperRegistryClient();

  const fetchBalance = useCallback(
    () => client.keeperBalance(address),
    [client, address],
  );

  const {
    data,
    loading,
    error,
    refetch,
  } = usePolling<bigint>(
    fetchBalance,
    options,
  );

  return {
    balance: data ?? 0n,
    loading,
    error,
    refetch,
  };
}
