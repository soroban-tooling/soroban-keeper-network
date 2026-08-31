import { useCallback, useState } from "react";
import { useKeeperRegistryClient } from "./provider";

export type RegisterTaskStatus =
  | "idle"
  | "pending"
  | "success"
  | "error";

export interface UseRegisterTaskResult<TParams, TTaskId> {
  registerTask: (params: TParams) => Promise<TTaskId>;
  status: RegisterTaskStatus;
  error: Error | null;
  reset: () => void;
}

export function useRegisterTask<
  TParams extends Parameters<
    ReturnType<typeof useKeeperRegistryClient>["registerTask"]
  >[0],
  TTaskId = Awaited<
    ReturnType<
      ReturnType<typeof useKeeperRegistryClient>["registerTask"]
    >
  >,
>(): UseRegisterTaskResult<TParams, TTaskId> {
  const client = useKeeperRegistryClient();

  const [status, setStatus] = useState<RegisterTaskStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const registerTask = useCallback(
    async (params: TParams): Promise<TTaskId> => {
      setStatus("pending");
      setError(null);

      try {
        const taskId = await client.registerTask(params);

        setStatus("success");

        return taskId as TTaskId;
      } catch (cause) {
        const normalizedError =
          cause instanceof Error
            ? cause
            : new Error(String(cause));

        setError(normalizedError);
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
    registerTask,
    status,
    error,
    reset,
  };
}
