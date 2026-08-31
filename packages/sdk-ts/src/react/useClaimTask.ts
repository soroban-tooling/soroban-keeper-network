import {
  useCallback,
  useState,
} from "react";

import { useKeeperRegistryClient } from "./provider";

export type ClaimTaskStatus =
  | "idle"
  | "pending"
  | "success"
  | "error";

export interface UseClaimTaskResult {
  claimTask: (taskId: bigint) => Promise<unknown>;
  status: ClaimTaskStatus;
  error: Error | null;
  reset: () => void;
}

export function useClaimTask(): UseClaimTaskResult {
  const client = useKeeperRegistryClient();

  const [status, setStatus] =
    useState<ClaimTaskStatus>("idle");

  const [error, setError] =
    useState<Error | null>(null);

  const claimTask = useCallback(
    async (taskId: bigint) => {
      setStatus("pending");
      setError(null);

      try {
        const result = await client.claimTask({
          taskId,
        });

        setStatus("success");

        return result;
      } catch (cause) {
        const normalized =
          cause instanceof Error
            ? cause
            : new Error(String(cause));

        setError(normalized);
        setStatus("error");

        throw cause;
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    claimTask,
    status,
    error,
    reset,
  };
}
