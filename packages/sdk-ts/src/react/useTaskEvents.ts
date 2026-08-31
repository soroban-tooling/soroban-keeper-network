// The event-stream counterpart to `useTask`: a task list wanting to show
// *new* task registrations (or claims, executions, ...) as they happen,
// rather than one task's re-fetched state. See backlog 0179 / issue #248.
//
// Polling-based, not a true push subscription — Soroban RPC has no
// server-push equivalent a browser client can use directly. Documented
// explicitly (not just in this comment) via {@link UseTaskEventsResult}'s
// doc comment, so a consumer's expectations are set correctly rather than
// implying real-time push.

import { useCallback, useEffect, useRef, useState } from "react";

import { decodeTaskEvent, type TaskEvent } from "../events";
import { useKeeperRegistryClient } from "./provider";

const DEFAULT_POLL_INTERVAL_MS = 5000;
/** `getEvents` retention window is short-lived on most RPC providers; a page just mounted has no prior cursor, so it starts from "now" rather than attempting to backfill history it may not be entitled to. */
const EVENTS_PER_POLL_LIMIT = 100;

export interface UseTaskEventsOptions {
  /** Restrict to these event types; defaults to every type this SDK decodes (see `events.ts`). */
  eventTypes?: ReadonlyArray<TaskEvent["type"]>;
  /** Milliseconds between polls. Defaults to 5000ms. */
  pollIntervalMs?: number;
}

export interface UseTaskEventsResult {
  /**
   * A growing, deduplicated list of decoded events matching `eventTypes`,
   * oldest first. **Polling-based, not push** — a new event can take up to
   * `pollIntervalMs` to appear here after it actually happened on-chain;
   * this hook does not and cannot offer a lower-latency guarantee, since
   * Soroban RPC has no push-subscription mechanism a browser client can
   * use directly.
   */
  events: TaskEvent[];
  loading: boolean;
  error: Error | undefined;
}

/**
 * Polls `getEvents` for the keeper-registry contract's task-lifecycle
 * events, maintaining its own ledger cursor across polls (the same
 * cross-round cursor pattern `examples/keeper-bot`'s `fetchPendingTasks`
 * establishes) so it never re-fetches or re-decodes the same ledger range
 * twice, and never delivers the same event to the consumer twice even if
 * the underlying RPC response were to overlap a previous page.
 */
export function useTaskEvents(options: UseTaskEventsOptions = {}): UseTaskEventsResult {
  const { eventTypes, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options;
  const client = useKeeperRegistryClient();

  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  // Cross-round state that must survive re-renders without itself
  // triggering one — a `cursor` in `useState` would cause an extra render
  // on every poll for no observable benefit, since only `events` needs to
  // trigger a re-render.
  const cursorRef = useRef<string | undefined>(undefined);
  // Every event this hook has ever delivered, by its RPC-assigned `id`
  // (globally unique per event — see `EventResponse.id` in
  // `@stellar/stellar-sdk`'s rpc/api.d.ts) — the actual de-duplication
  // guard. The cursor alone prevents re-fetching the same ledger range on
  // the *next* poll, but does not protect against the same event id
  // appearing twice within how `getEvents` paginates a single poll's
  // result set (e.g. a page boundary landing mid-ledger).
  const seenEventIds = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    try {
      const server = client.invoker.getServer();
      const request =
        cursorRef.current !== undefined
          ? { cursor: cursorRef.current, limit: EVENTS_PER_POLL_LIMIT }
          : {
              // First poll: no prior cursor, so start from the current
              // ledger rather than the beginning of the retention window —
              // a task list mounting for the first time shows new activity
              // going forward, not a full history replay.
              startLedger: (await server.getLatestLedger()).sequence,
              limit: EVENTS_PER_POLL_LIMIT,
            };

      const response = await server.getEvents({
        ...request,
        filters: [{ type: "contract", contractIds: [client.config.contractId] }],
      });

      cursorRef.current = response.cursor;

      const newEvents: TaskEvent[] = [];
      for (const raw of response.events) {
        if (seenEventIds.current.has(raw.id)) continue;
        seenEventIds.current.add(raw.id);

        const decoded = decodeTaskEvent(raw.topic, raw.value);
        if (decoded.type === "Unknown") continue; // not a task-lifecycle event this SDK decodes
        if (eventTypes && !eventTypes.includes(decoded.type)) continue;
        newEvents.push(decoded);
      }

      if (newEvents.length > 0) {
        setEvents((prev) => [...prev, ...newEvents]);
      }
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `eventTypes` is intentionally read fresh each poll without retriggering the effect below; see its array-identity note there.
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void poll();
    };

    tick();
    const intervalId = setInterval(tick, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // `eventTypes` is deliberately excluded: an inline array literal
    // (`useTaskEvents({ eventTypes: ["TaskClaimed"] })`) would otherwise
    // have a new identity every render, restarting polling (and resetting
    // the cursor/dedup state) on every parent re-render rather than only
    // when the poll interval or client actually changes. `poll`'s closure
    // reads the current `eventTypes` value fresh on every tick regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, pollIntervalMs]);

  return { events, loading, error };
}
