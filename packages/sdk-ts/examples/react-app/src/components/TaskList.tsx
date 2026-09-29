import { useTaskEvents } from "@soroban-keeper-network/sdk/react";

/**
 * Live feed of task-lifecycle events via `useTaskEvents` (backlog 0179 /
 * issue #248). Polling-based, not push — see the hook's own doc comment —
 * so a just-registered task can take up to its `pollIntervalMs` to appear.
 */
export function TaskList() {
  const { events, loading, error } = useTaskEvents({ pollIntervalMs: 5000 });

  if (error) {
    return <p role="alert">Failed to load task events: {error.message}</p>;
  }

  return (
    <div>
      {loading && events.length === 0 ? <p>Loading recent activity…</p> : null}
      {!loading && events.length === 0 ? (
        <p>No task events observed yet since this page loaded.</p>
      ) : null}
      <ul>
        {events.map((event, i) => (
          // Events have no single globally-unique field exposed to this
          // component (the RPC event id is internal to the hook's dedup
          // logic); index is stable here because the hook only ever appends.
          // eslint-disable-next-line react/no-array-index-key
          <li key={i}>
            <strong>{event.type}</strong> — task #{"taskId" in event ? String(event.taskId) : "?"}
          </li>
        ))}
      </ul>
    </div>
  );
}
