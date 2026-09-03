import { useCallback } from "react";
import type { IntegerInput } from "../core/scval.js";
import { useKeeperRegistryClient } from "./provider.js";
import {
  usePolling,
  type PollingOptions,
} from "./usePolling.js";

export interface UseIsClaimableOptions
  extends PollingOptions {}

export interface UseIsClaimableResult {
  isClaimable: boolean;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useIsClaimable(
  taskId: IntegerInput,
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
