import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Address } from "../components/Address";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import { StatusBadge } from "../components/StatusBadge";
import { useDashboardData } from "../data/context";
import type { TaskState, TaskStatus } from "../data/types";

const statuses: Array<"all" | TaskStatus> = ["all", "pending", "claimed", "executed", "cancelled", "expired"];

export function TasksPage() {
  const { indexer } = useDashboardData();
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [status, setStatus] = useState<(typeof statuses)[number]>("all");
  const [sort, setSort] = useState<"reward" | "deadline">("deadline");
  const [ascending, setAscending] = useState(true);
  const [cursor, setCursor] = useState<number | undefined>();
  const [history, setHistory] = useState<Array<number | undefined>>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const page = await indexer.allTasks(cursor, 25);
      setTasks(page.items); setNextCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load tasks"); }
    finally { setLoading(false); }
  }, [cursor, indexer]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => tasks
    .filter((task) => status === "all" || task.status === status)
    .sort((a, b) => {
      const result = sort === "reward"
        ? BigInt(a.reward) < BigInt(b.reward) ? -1 : BigInt(a.reward) > BigInt(b.reward) ? 1 : 0
        : a.deadline - b.deadline;
      return ascending ? result : -result;
    }), [ascending, sort, status, tasks]);

  return <section className="page">
    <div className="page-heading"><div><p className="eyebrow">Indexed registry state</p><h1>Task explorer</h1><p>Review registered work, deadlines, rewards, owners, and active claims.</p></div></div>
    <div className="toolbar">
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
      <div className="segmented" aria-label="Sort tasks"><button className={sort === "deadline" ? "selected" : ""} onClick={() => setSort("deadline")}>Deadline</button><button className={sort === "reward" ? "selected" : ""} onClick={() => setSort("reward")}>Reward</button></div>
      <button className="icon-button" title={ascending ? "Sort descending" : "Sort ascending"} aria-label={ascending ? "Sort descending" : "Sort ascending"} onClick={() => setAscending((value) => !value)}>{ascending ? <ArrowUp /> : <ArrowDown />}</button>
    </div>
    {loading ? <LoadingState label="Loading tasks" /> : error ? <ErrorState message={error} retry={() => void load()} /> : visible.length === 0 ? <EmptyState message="No tasks match this view." /> : <div className="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Reward</th><th>Deadline</th><th>Owner</th><th>Claimer</th></tr></thead><tbody>{visible.map((task) => <tr key={task.task_id}><td><Link to={`/tasks/${task.task_id}`}>#{task.task_id}</Link></td><td><StatusBadge status={task.status} /></td><td className="numeric">{BigInt(task.reward).toLocaleString()}</td><td>{new Date(task.deadline * 1000).toLocaleString()}</td><td><Address value={task.owner} /></td><td><Address value={task.keeper} /></td></tr>)}</tbody></table></div>}
    <div className="pagination"><button disabled={history.length === 0 || loading} onClick={() => { const previous = history.at(-1); setHistory((items) => items.slice(0, -1)); setCursor(previous); }}><ChevronLeft />Previous</button><button disabled={nextCursor === null || loading} onClick={() => { setHistory((items) => [...items, cursor]); setCursor(nextCursor ?? undefined); }}>Next<ChevronRight /></button></div>
  </section>;
}
