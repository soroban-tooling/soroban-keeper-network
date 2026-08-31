import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingOptions {
  pollIntervalMs?: number;
}

export interface PollingResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error));
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  options: PollingOptions = {},
): PollingResult<T> {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  const fetcherRef = useRef(fetcher);
  const mountedRef = useRef(true);

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const refetch = useCallback(async () => {
    if (!mountedRef.current) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const nextData = await fetcherRef.current();

      if (!mountedRef.current) {
        return;
      }

      setData(nextData);
      setError(null);
    } catch (cause) {
      if (!mountedRef.current) {
        return;
      }

      setError(normalizeError(cause));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    void refetch();

    return () => {
      mountedRef.current = false;
    };
  }, [refetch]);

  useEffect(() => {
    if (
      typeof document === "undefined" ||
      typeof window === "undefined"
    ) {
      return;
    }

    let intervalId: ReturnType<typeof window.setInterval> | null =
      null;

    const startPolling = () => {
      if (intervalId !== null) {
        return;
      }

      if (document.visibilityState === "hidden") {
        return;
      }

      intervalId = window.setInterval(() => {
        if (document.visibilityState !== "hidden") {
          void refetch();
        }
      }, pollIntervalMs);
    };

    const stopPolling = () => {
      if (intervalId === null) {
        return;
      }

      window.clearInterval(intervalId);
      intervalId = null;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refetch();
        startPolling();
      } else {
        stopPolling();
      }
    };

    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );

    startPolling();

    return () => {
      stopPolling();

      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    };
  }, [pollIntervalMs, refetch]);

  return {
    data,
    loading,
    error,
    refetch,
  };
}
