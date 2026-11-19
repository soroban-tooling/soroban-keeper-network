import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Address } from "../components/Address";
import { ErrorState, LoadingState } from "../components/AsyncState";
import { StatusBadge } from "../components/StatusBadge";
import { KeeperActions } from "../components/KeeperActions";
import { useDashboardData } from "../data/context";
import type { TaskState } from "../data/types";

interface Metrics { balance: bigint; stake: bigint; reputation: number; unbond?: { amount: bigint; unlockLedger: number }; slashCount: number; totalSlashed: bigint }

export function KeeperPage() {
  const { keeper = "" } = useParams();
  const { indexer, registry } = useDashboardData();
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [taskPage, leaderboard] = await Promise.all([indexer.tasksByKeeper(keeper), indexer.leaderboard("reputation", 200)]);
      setTasks(taskPage.items);
      if (registry) {
        const [balance, stake, reputation, unbond, slash] = await Promise.all([registry.keeperBalance(keeper), registry.keeperStake(keeper), registry.keeperReputation(keeper), registry.pendingUnbond(keeper), registry.slashHistory(keeper)]);
        setMetrics({ balance, stake, reputation, unbond, slashCount: slash.count, totalSlashed: slash.totalSlashed });
      } else {
        const indexed = leaderboard.find((entry) => entry.keeper === keeper);
        setMetrics({ balance: 0n, stake: 0n, reputation: Number(indexed?.reputation ?? 0), slashCount: 0, totalSlashed: 0n });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load keeper"); }
    finally { setLoading(false); }
  }, [indexer, keeper, registry]);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <section className="page"><LoadingState label="Loading keeper" /></section>;
  if (error || !metrics) return <section className="page"><ErrorState message={error ?? "Keeper not found"} retry={() => void load()} /></section>;

  return <section className="page"><div className="page-heading"><div><p className="eyebrow">Keeper profile</p><h1><Address value={keeper} /></h1><p>{registry ? "Contract state is live; task history is indexed." : "Indexer data loaded. Contract metrics await network configuration."}</p></div></div>
    <div className="metric-grid"><article><span>Withdrawable balance</span><strong>{metrics.balance.toLocaleString()}</strong><small>Live contract</small></article><article><span>Effective stake</span><strong>{metrics.stake.toLocaleString()}</strong><small>Live contract</small></article><article><span>Reputation</span><strong>{metrics.reputation.toLocaleString()}</strong><small>Live contract</small></article><article><span>Slash history</span><strong>{metrics.slashCount}</strong><small>{metrics.totalSlashed.toLocaleString()} total slashed</small></article></div>
    {metrics.unbond && <div className="notice"><strong>Pending unbond</strong><span>{metrics.unbond.amount.toLocaleString()} unlocks at ledger {metrics.unbond.unlockLedger.toLocaleString()}</span></div>}
    <KeeperActions keeper={keeper} balance={metrics.balance} unbond={metrics.unbond} />
    <div className="section-heading"><h2>Recent tasks</h2><span>{tasks.length} indexed</span></div>
    <div className="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Reward</th><th>Last ledger</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.task_id}><td><Link to={`/tasks/${task.task_id}`}>#{task.task_id}</Link></td><td><StatusBadge status={task.status} /></td><td className="numeric">{BigInt(task.reward).toLocaleString()}</td><td>{task.last_ledger.toLocaleString()}</td></tr>)}</tbody></table></div>
  </section>;
}
