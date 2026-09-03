import {
  useCallback,
  useState,
} from "react";

import type { ClaimTaskOutcome, ClaimTaskParams } from "../methods/claimTask.js";
import { useKeeperRegistryClient } from "./provider.js";

export type ClaimTaskStatus =
  | "idle"
  | "pending"
  | "success"
  | "error";

export interface UseClaimTaskResult {
  claimTask: (params: ClaimTaskParams) => Promise<ClaimTaskOutcome>;
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
    async (params: ClaimTaskParams) => {
      setStatus("pending");
      setError(null);

      try {
        const result = await client.claimTask(params);

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
