import { useCallback } from "react";
import { useKeeperRegistryClient } from "./provider";
import {
  usePolling,
  type PollingOptions,
} from "./usePolling";

export interface UseIsClaimableOptions
  extends PollingOptions {}

export interface UseIsClaimableResult {
  isClaimable: boolean;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useIsClaimable(
  taskId: bigint | number | string,
  options: UseIsClaimableOptions = {},
): UseIsClaimableResult {
  const client = useKeeperRegistryClient();

  const fetchIsClaimable = useCallback(
    () => client.isClaimable(taskId),
    [client, taskId],
  );

  const {
    data,
    loading,
    error,
    refetch,
  } = usePolling<boolean>(
    fetchIsClaimable,
    options,
  );

  return {
    isClaimable: data ?? false,
    loading,
    error,
    refetch,
  };
}
