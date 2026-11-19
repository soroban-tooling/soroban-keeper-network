import { ArrowLeft, Coins, ExternalLink, Filter, Lock, PlusCircle, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Address } from "../components/Address";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import { LiveStatus } from "../components/LiveStatus";
import { StatusBadge } from "../components/StatusBadge";
import { useDashboardData } from "../data/context";
import type { TaskState, TaskStatus } from "../data/types";
import { formatAbsoluteTime, formatRelativeTime, formatStroops } from "../format";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { useWallet } from "../wallet/WalletProvider";

interface StatusTotals {
  pending: bigint;
  claimed: bigint;
  executed: bigint;
  cancelled: bigint;
  expired: bigint;
}

interface StatusCounts {
  pending: number;
  claimed: number;
  executed: number;
  cancelled: number;
  expired: number;
}

const ALL_STATUSES: TaskStatus[] = ["pending", "claimed", "executed", "cancelled", "expired"];

export function OwnerPage() {
  const { owner = "" } = useParams();
  const { indexer } = useDashboardData();
  const { account: connectedAddress } = useWallet();

  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string>("all");

  const isCurrentWallet = Boolean(
    connectedAddress && owner && connectedAddress.toLowerCase() === owner.toLowerCase()
  );

  const load = useCallback(async () => {
    if (!owner) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await indexer.tasksByOwner(owner, undefined, 100);
      setTasks(page.items);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [indexer, owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = useLiveEvents(() => void load());

  // Calculate totals locked in rewards by status
  const { totals, counts, totalLocked } = useMemo(() => {
    const sumTotals: StatusTotals = {
      pending: 0n,
      claimed: 0n,
      executed: 0n,
      cancelled: 0n,
      expired: 0n,
    };

    const sumCounts: StatusCounts = {
      pending: 0,
      claimed: 0,
      executed: 0,
      cancelled: 0,
      expired: 0,
    };

    for (const t of tasks) {
      const rewardBig = BigInt(t.reward || "0");
      if (t.status in sumTotals) {
        sumTotals[t.status as TaskStatus] += rewardBig;
        sumCounts[t.status as TaskStatus] += 1;
      }
    }

    // Locked capital = pending + claimed
    const locked = sumTotals.pending + sumTotals.claimed;

    return { totals: sumTotals, counts: sumCounts, totalLocked: locked };
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    if (selectedStatus === "all") return tasks;
    return tasks.filter((t) => t.status === selectedStatus);
  }, [tasks, selectedStatus]);

  return (
    <section className="page">
      <Link className="back-link" to="/tasks">
        <ArrowLeft size={16} />
        Tasks
      </Link>

      <div className="page-heading">
        <div>
          <p className="eyebrow">Task Owner Profile</p>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1>
              <Address value={owner} />
            </h1>
            {isCurrentWallet && (
              <span
                style={{
                  fontSize: "0.78rem",
                  background: "var(--accent, #3b82f6)",
                  color: "#fff",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontWeight: 600,
                }}
              >
                Connected Wallet
              </span>
            )}
          </div>
          <p>Review all registered tasks and capital escrowed in bounties.</p>
        </div>
        <LiveStatus state={live} />
      </div>

      {loading ? (
        <LoadingState label="Loading owner tasks and reward totals..." skeleton="table" />
      ) : error ? (
        <ErrorState error={error} source="indexer" retry={() => void load()} />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No tasks registered"
          message={`Address ${owner} has not registered any tasks on the Soroban Keeper Network.`}
          explanation="Tasks registered through the dashboard or contract with this address as the owner will be tracked here along with locked escrow totals."
          action={
            isCurrentWallet
              ? {
                  label: "Register a task",
                  onClick: () => {
                    window.location.href = "/register";
                  },
                }
              : undefined
          }
        />
      ) : (
        <>
          {/* Summary metric cards showing rewards totaled by status */}
          <div className="metric-grid" style={{ marginBottom: 24 }}>
            <article style={{ borderLeft: "3px solid #3b82f6" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Lock size={14} color="#3b82f6" />
                Total Locked Escrow
              </span>
              <strong style={{ fontSize: "1.4rem" }}>{formatStroops(totalLocked)}</strong>
              <small>
                {counts.pending + counts.claimed} active tasks (Pending + Claimed)
              </small>
            </article>

            <article>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Coins size={14} />
                Pending Rewards
              </span>
              <strong style={{ fontSize: "1.4rem" }}>{formatStroops(totals.pending)}</strong>
              <small>{counts.pending} tasks awaiting keeper claims</small>
            </article>

            <article>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Coins size={14} />
                Claimed In-Flight
              </span>
              <strong style={{ fontSize: "1.4rem" }}>{formatStroops(totals.claimed)}</strong>
              <small>{counts.claimed} tasks actively claimed by keepers</small>
            </article>

            <article>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Coins size={14} />
                Executed / Paid
              </span>
              <strong style={{ fontSize: "1.4rem" }}>{formatStroops(totals.executed)}</strong>
              <small>{counts.executed} tasks executed successfully</small>
            </article>

            <article>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Coins size={14} />
                Refunded / Inactive
              </span>
              <strong style={{ fontSize: "1.4rem" }}>
                {formatStroops(totals.cancelled + totals.expired)}
              </strong>
              <small>
                {counts.cancelled} cancelled · {counts.expired} expired
              </small>
            </article>
          </div>

          {/* Filter Toolbar */}
          <div
            className="filter-bar"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Filter size={15} color="var(--ink-muted)" />
              <span style={{ fontSize: "0.88rem", fontWeight: 500 }}>Status:</span>
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                style={{
                  background: "var(--surface)",
                  color: "var(--ink)",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: "0.85rem",
                }}
              >
                <option value="all">All statuses ({tasks.length})</option>
                {ALL_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st.charAt(0).toUpperCase() + st.slice(1)} ({counts[st]})
                  </option>
                ))}
              </select>
            </div>

            <span style={{ fontSize: "0.85rem", color: "var(--ink-muted)" }}>
              Showing {visibleTasks.length} of {tasks.length} tasks
            </span>
          </div>

          {/* Tasks Table */}
          {visibleTasks.length === 0 ? (
            <EmptyState
              title={`No ${selectedStatus} tasks`}
              message={`This owner has no tasks with status "${selectedStatus}".`}
              action={{
                label: "Clear filter",
                onClick: () => setSelectedStatus("all"),
              }}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Task ID</th>
                    <th>Status</th>
                    <th className="numeric">Reward (Tokens)</th>
                    <th className="numeric">Net Paid</th>
                    <th>Deadline</th>
                    <th>Claimer (Keeper)</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTasks.map((task) => (
                    <tr key={task.task_id}>
                      <td>
                        <Link to={`/tasks/${task.task_id}`} style={{ fontWeight: 600 }}>
                          #{task.task_id}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={task.status} />
                      </td>
                      <td className="numeric" style={{ fontFamily: "monospace" }}>
                        {formatStroops(task.reward)}
                      </td>
                      <td className="numeric" style={{ fontFamily: "monospace", color: "var(--ink-muted)" }}>
                        {task.net_reward && task.net_reward !== "0"
                          ? formatStroops(task.net_reward)
                          : "—"}
                      </td>
                      <td>
                        <span title={formatAbsoluteTime(task.deadline)}>
                          {formatRelativeTime(task.deadline)}
                        </span>
                      </td>
                      <td>
                        <Address value={task.keeper} />
                      </td>
                      <td>
                        <Link
                          to={`/tasks/${task.task_id}`}
                          className="action-link"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: "0.82rem",
                          }}
                        >
                          View
                          <ExternalLink size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
