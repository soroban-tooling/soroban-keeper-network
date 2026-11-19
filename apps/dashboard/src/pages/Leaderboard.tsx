import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Address } from "../components/Address";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import { useDashboardData } from "../data/context";
import type { LeaderboardEntry } from "../data/types";

type RankBy = "executions" | "reward" | "reputation";
const pageSize = 20;

export function LeaderboardPage() {
  const { indexer } = useDashboardData();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [rankBy, setRankBy] = useState<RankBy>("executions");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setEntries(await indexer.leaderboard(rankBy, 200)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load keepers"); } finally { setLoading(false); } }, [indexer, rankBy]);
  useEffect(() => { setPage(0); void load(); }, [load]);
  const pageEntries = useMemo(() => entries.slice(page * pageSize, (page + 1) * pageSize), [entries, page]);

  return <section className="page"><div className="page-heading"><div><p className="eyebrow">Performance</p><h1>Keeper leaderboard</h1><p>Compare execution volume, earned rewards, and effective reputation.</p></div></div>
    <div className="toolbar"><div className="segmented" aria-label="Leaderboard ranking">{(["executions", "reward", "reputation"] as RankBy[]).map((value) => <button key={value} className={rankBy === value ? "selected" : ""} onClick={() => setRankBy(value)}>{value}</button>)}</div></div>
    {loading ? <LoadingState label="Loading keepers" /> : error ? <ErrorState message={error} retry={() => void load()} /> : pageEntries.length === 0 ? <EmptyState message="No keeper executions have been indexed." /> : <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Keeper</th><th>Executions</th><th>Rewards earned</th><th>Reputation</th></tr></thead><tbody>{pageEntries.map((entry) => <tr key={entry.keeper}><td className="rank">{entry.rank}</td><td><Link to={`/keepers/${entry.keeper}`}><Address value={entry.keeper} /></Link></td><td className="numeric">{entry.executions.toLocaleString()}</td><td className="numeric">{BigInt(entry.total_reward).toLocaleString()}</td><td className="numeric">{entry.reputation}</td></tr>)}</tbody></table></div>}
    <div className="pagination"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft />Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(entries.length / pageSize))}</span><button disabled={(page + 1) * pageSize >= entries.length} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight /></button></div>
  </section>;
}
