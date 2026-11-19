import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Address } from "../components/Address";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import { LiveStatus } from "../components/LiveStatus";
import { OwnerActions } from "../components/OwnerActions";
import { StatusBadge } from "../components/StatusBadge";
import { useDashboardData } from "../data/context";
import { IndexerRequestError, type TaskDetail } from "../data/indexer";
import { formatAbsoluteTime, formatStroops } from "../format";
import { useLiveEvents } from "../hooks/useLiveEvents";

export function TaskDetailPage() {
  const taskId = Number(useParams().taskId);
  const { indexer, registry } = useDashboardData();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [lockEnd, setLockEnd] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const load = useCallback(async () => {
    if (!Number.isSafeInteger(taskId) || taskId < 0) { setNotFound(true); setLoading(false); return; }
    setError(null);
    try {
      const result = await indexer.taskDetail(taskId); setDetail(result); setNotFound(false);
      if (registry) { const liveTask = await registry.task(taskId); if (liveTask.claimLedger !== undefined) setLockEnd(liveTask.claimLedger + liveTask.lockLedgers); }
    } catch (cause) { if (cause instanceof IndexerRequestError && cause.status === 404) setNotFound(true); else setError(cause instanceof Error ? cause.message : "Unable to load task"); }
    finally { setLoading(false); }
  }, [indexer, registry, taskId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = setInterval(() => tick((value) => value + 1), 1_000); return () => clearInterval(timer); }, []);
  const live = useLiveEvents(() => void load());
  if (loading)
    return (
      <section className="page">
        <Link className="back-link" to="/tasks">
          <ArrowLeft />
          Tasks
        </Link>
        <LoadingState label="Loading task details..." skeleton="cards" count={4} />
      </section>
    );

  if (notFound)
    return (
      <section className="page">
        <Link className="back-link" to="/tasks">
          <ArrowLeft />
          Tasks
        </Link>
        <EmptyState
          title="Task Not Found"
          message={`Task #${Number.isFinite(taskId) ? taskId : "unknown"} was not found on this network.`}
          explanation="The task ID may not exist, or the indexer has not yet picked up the registration transaction from the ledger."
        />
      </section>
    );

  if (error || !detail)
    return (
      <section className="page">
        <Link className="back-link" to="/tasks">
          <ArrowLeft />
          Tasks
        </Link>
        <ErrorState error={error ?? "Unable to load task"} source="indexer" retry={() => void load()} />
      </section>
    );

  const { task, history } = detail;
  const seconds = task.deadline - Math.floor(Date.now() / 1000);
  return (
    <section className="page">
      <Link className="back-link" to="/tasks">
        <ArrowLeft />
        Tasks
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Task #{task.task_id}</p>
          <h1>
            <StatusBadge status={task.status} />
          </h1>
          <p>
            Owned by <Address value={task.owner} />
          </p>
        </div>
        <LiveStatus state={live} />
      </div>
      <div className="metric-grid">
        <article>
          <span>Reward</span>
          <strong>{formatStroops(task.reward)}</strong>
          <small>
            {task.net_reward !== "0"
              ? `${formatStroops(task.net_reward)} net paid`
              : "Escrowed"}
          </small>
        </article>
        <article>
          <span>Deadline</span>
          <strong className={seconds < 0 ? "danger-text" : ""}>{formatRemaining(seconds)}</strong>
          <small>{formatAbsoluteTime(task.deadline)}</small>
        </article>
        <article>
          <span>Claim lock</span>
          <strong>
            {lockEnd === null ? "Not available" : `Ledger ${lockEnd.toLocaleString()}`}
          </strong>
          <small>
            {task.claim_ledger ? `Claimed at ${task.claim_ledger.toLocaleString()}` : "Not claimed"}
          </small>
        </article>
        <article>
          <span>Claimer</span>
          <strong>
            <Address value={task.keeper} />
          </strong>
          <small>Last event ledger {task.last_ledger.toLocaleString()}</small>
        </article>
      </div>
      <OwnerActions task={task} />
      <div className="section-heading">
        <h2>Event history</h2>
        <span>{history.length} events, oldest first</span>
      </div>
      <ol className="timeline">
        {history.map((event) => (
          <li key={`${event.tx_hash}-${event.event_index}`}>
            <span className="timeline-dot" />
            <div>
              <strong>{event.event_type.replaceAll("_", " ")}</strong>
              <span>
                Ledger {event.ledger.toLocaleString()} at {formatAbsoluteTime(event.ledger_close_time)}
              </span>
              <code>{event.tx_hash}</code>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "Expired";
  const days = Math.floor(seconds / 86_400); const hours = Math.floor(seconds % 86_400 / 3_600); const minutes = Math.floor(seconds % 3_600 / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}
