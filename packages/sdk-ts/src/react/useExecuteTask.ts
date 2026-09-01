import {
  useCallback,
  useState,
} from "react";

import { useKeeperRegistryClient } from "./provider";

export type ExecuteTaskStatus =
  | "idle"
  | "pending"
  | "success"
  | "error";

export interface UseExecuteTaskResult<Proof> {
  executeTask: (
    params: {
      taskId: bigint;
      proof: Proof;
    },
  ) => Promise<unknown>;
  status: ExecuteTaskStatus;
  error: Error | null;
  reset: () => void;
}

export function useExecuteTask<Proof>(): UseExecuteTaskResult<Proof> {
  const client = useKeeperRegistryClient();

  const [status, setStatus] =
    useState<ExecuteTaskStatus>("idle");

  const [error, setError] =
    useState<Error | null>(null);

  const executeTask = useCallback(
    async ({
      taskId,
      proof,
    }: {
      taskId: bigint;
      proof: Proof;
    }) => {
      setStatus("pending");
      setError(null);

      try {
        const result = await client.executeTask({
          taskId,
          proof,
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
    executeTask,
    status,
    error,
    reset,
  };
}
