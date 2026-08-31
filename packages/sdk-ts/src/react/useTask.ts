// The first data-fetching hook of the React slice: a component showing one
// task's live state needs to re-poll, since Soroban views have no
// push-subscription mechanism a browser client can use directly. See
// backlog 0174 / issue #243.

import { useCallback, useEffect, useRef, useState } from "react";

import { TaskNotFoundError } from "../errors";
import type { Task } from "../types";
import { useKeeperRegistryClient } from "./provider";

const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface UseTaskOptions {
  /** Milliseconds between polls. Defaults to 5000ms — frequent enough for a task-detail view to feel live, infrequent enough not to hammer RPC. */
  pollIntervalMs?: number;
}

export interface UseTaskResult {
  task: Task | undefined;
  loading: boolean;
  /**
   * Distinguishes "this task doesn't exist" ({@link TaskNotFoundError}) from
   * a transient network/RPC failure (any other `Error`), so a UI can render
   * "this task doesn't exist" instead of "loading forever" for the former —
   * see the issue's acceptance criteria.
   */
  error: TaskNotFoundError | Error | undefined;
  refetch: () => void;
}

/**
 * Polls `getTask(taskId)` at `pollIntervalMs`, pausing while the tab is
 * backgrounded (via the Page Visibility API) to avoid wasting RPC calls on
 * an unwatched tab, and stopping cleanly on unmount.
 *
 * Note on scope: this pauses on *tab* visibility (`document.hidden`), the
 * browser-tab-level signal the issue's acceptance criteria asks for. It
 * does not additionally pause when the hosting component itself is
 * scrolled off-screen or mounted-but-hidden within a visible tab (the
 * `IntersectionObserver`-based pattern used elsewhere in this monorepo,
 * e.g. Sorokit/ui's `useIsVisible`, addresses that different, narrower
 * problem) — out of scope here, since `getTask`'s consumer is typically a
 * single always-relevant task-detail view, not a dashboard of many
 * simultaneously-mounted polling widgets.
 */
export function useTask(taskId: number, options: UseTaskOptions = {}): UseTaskResult {
  const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options;
  const client = useKeeperRegistryClient();

  const [task, setTask] = useState<Task | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TaskNotFoundError | Error | undefined>(undefined);

  // A manually-triggered refetch (and the effect's own poll tick) must not
  // race a still-in-flight fetch and apply a stale response after a newer
  // one — this generation counter discards any response that isn't from
  // the most recently started fetch.
  const fetchGeneration = useRef(0);

  const fetchTask = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    try {
      const result = await client.getTask(taskId);
      if (fetchGeneration.current !== generation) return; // superseded
      setTask(result);
      setError(undefined);
    } catch (err) {
      if (fetchGeneration.current !== generation) return; // superseded
      setError(err instanceof TaskNotFoundError ? err : err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (fetchGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, [client, taskId]);

  const refetch = useCallback(() => {
    setLoading(true);
    void fetchTask();
  }, [fetchTask]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const isDocumentHidden = () => typeof document !== "undefined" && document.hidden;

    const tick = () => {
      if (cancelled || isDocumentHidden()) return;
      void fetchTask();
    };

    // Initial fetch fires immediately regardless of visibility — a task
    // detail view navigated to directly should never start blank.
    void fetchTask();
    intervalId = setInterval(tick, pollIntervalMs);

    const handleVisibilityChange = () => {
      // Resuming from hidden should refresh immediately rather than
      // waiting up to a full `pollIntervalMs` for the next tick — a user
      // switching back to the tab expects current data right away.
      if (!isDocumentHidden()) {
        void fetchTask();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [fetchTask, pollIntervalMs]);

  return { task, loading, error, refetch };
}
