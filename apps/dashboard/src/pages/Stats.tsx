import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorState, LoadingState } from "../components/AsyncState";
import { useDashboardData } from "../data/context";
import type { IndexedEvent } from "../data/types";

interface Point { label: string; tasks: number; rewards: bigint }

export function StatsPage() {
  const { indexer } = useDashboardData();
  const [events, setEvents] = useState<IndexedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const collected: IndexedEvent[] = []; let cursor: number | undefined; do { const page = await indexer.events(cursor, 500); collected.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor !== undefined && collected.length < 5000); setEvents(collected); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load statistics"); } finally { setLoading(false); } }, [indexer]);
  useEffect(() => { void load(); }, [load]);
  const points = useMemo(() => aggregate(events), [events]);
  if (loading) return <section className="page"><LoadingState label="Loading chart data" /></section>;
  if (error) return <section className="page"><ErrorState message={error} retry={() => void load()} /></section>;
  return <section className="page"><div className="page-heading"><div><p className="eyebrow">Indexed trends</p><h1>Protocol activity</h1><p>Daily registrations, executions, and rewards paid from indexed event history.</p></div></div><div className="chart-grid"><AccessibleBars title="Tasks registered and executed" points={points} value={(point) => point.tasks} suffix=" tasks" /><AccessibleBars title="Rewards paid" points={points} value={(point) => Number(point.rewards)} suffix=" units" /></div></section>;
}

function aggregate(events: IndexedEvent[]): Point[] {
  const days = new Map<string, Point>();
  events.forEach((event) => {
    const label = new Date(event.ledger_close_time * 1000).toISOString().slice(0, 10);
    const point = days.get(label) ?? { label, tasks: 0, rewards: 0n };
    if (event.event_type === "task_registered" || event.event_type === "task_executed") point.tasks += 1;
    if (event.event_type === "task_executed") point.rewards += BigInt(String(event.payload.net_reward ?? 0));
    days.set(label, point);
  });
  return [...days.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-14);
}

function AccessibleBars({ title, points, value, suffix }: { title: string; points: Point[]; value: (point: Point) => number; suffix: string }) {
  const max = Math.max(1, ...points.map(value));
  return <article className="chart"><h2>{title}</h2><div className="bars" role="img" aria-label={`${title}: ${points.map((point) => `${point.label}, ${value(point)}${suffix}`).join("; ")}`}>{points.map((point) => <div className="bar-column" key={point.label}><span className="bar-value">{value(point).toLocaleString()}</span><div className="bar" style={{ height: `${Math.max(3, value(point) / max * 100)}%` }} /><span className="bar-label">{point.label.slice(5)}</span></div>)}</div></article>;
}
