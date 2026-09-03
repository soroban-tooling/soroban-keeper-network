import {
  useCallback,
  useState,
} from "react";

import type { ExecuteTaskParams } from "../methods/executeTask.js";
import { useKeeperRegistryClient } from "./provider.js";

export type ExecuteTaskStatus =
  | "idle"
  | "pending"
  | "success"
  | "error";

export interface UseExecuteTaskResult {
  executeTask: (params: ExecuteTaskParams) => Promise<void>;
  status: ExecuteTaskStatus;
  error: Error | null;
  reset: () => void;
}

export function useExecuteTask(): UseExecuteTaskResult {
  const client = useKeeperRegistryClient();

  const [status, setStatus] =
    useState<ExecuteTaskStatus>("idle");

  const [error, setError] =
    useState<Error | null>(null);

  const executeTask = useCallback(
    async (params: ExecuteTaskParams) => {
      setStatus("pending");
      setError(null);

      try {
        const result = await client.executeTask(params);

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
