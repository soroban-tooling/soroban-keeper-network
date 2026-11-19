import type { TaskStatus } from "../data/types";

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status status-${status}`}><span aria-hidden="true" className="status-dot" />{status}</span>;
}
