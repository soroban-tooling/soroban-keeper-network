import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import { useDashboardData } from "../data/context";
import type { IndexedEvent } from "../data/types";
import { formatStroops } from "../format";

interface Point { label: string; tasks: number; rewards: bigint }

export function StatsPage() {
  const { indexer } = useDashboardData();
  const [events, setEvents] = useState<IndexedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({ feeBps: 0, paused: false, feesAccrued: 0n });
  const { registry } = useDashboardData();
  const load = useCallback(async () => { setLoading(true); setError(null); try { const collected: IndexedEvent[] = []; let cursor: number | undefined; do { const page = await indexer.events(cursor, 500); collected.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor !== undefined && collected.length < 5000); setEvents(collected); const indexed = await indexer.adminConfig(); if (registry) { const [feeBps, paused, feesAccrued] = await Promise.all([registry.getFeeBps(), registry.isPaused(), registry.feesAccrued()]); setConfig({ feeBps, paused, feesAccrued }); } else { setConfig({ feeBps: indexed.fee_bps ?? 0, paused: indexed.paused ?? false, feesAccrued: BigInt(indexed.total_fees_swept) }); } } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load statistics"); } finally { setLoading(false); } }, [indexer, registry]);
  useEffect(() => { void load(); }, [load]);
  const points = useMemo(() => aggregate(events), [events]);
  if (loading)
    return (
      <section className="page">
        <LoadingState label="Loading protocol activity and metrics..." skeleton="cards" count={4} />
      </section>
    );

  if (error)
    return (
      <section className="page">
        <ErrorState error={error} source={registry ? "rpc" : "indexer"} retry={() => void load()} />
      </section>
    );

  if (events.length === 0)
    return (
      <section className="page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Indexed trends</p>
            <h1>Protocol activity</h1>
            <p>Daily registrations, executions, and rewards paid from indexed event history.</p>
          </div>
        </div>
        <EmptyState
          title="No activity recorded"
          message="No protocol events have been indexed yet on this network."
          explanation="Event charts and volume metrics will populate as tasks are registered, claimed, and executed."
        />
      </section>
    );

  const counts = events.reduce<Record<string, number>>((result, event) => {
    if (event.event_type.startsWith("task_")) result[event.event_type] = (result[event.event_type] ?? 0) + 1;
    return result;
  }, {});
  const activeKeepers = new Set(events.map((event) => String(event.payload.keeper ?? "")).filter(Boolean)).size;
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Indexed trends</p>
          <h1>Protocol activity</h1>
          <p>Daily registrations, executions, and rewards paid from indexed event history.</p>
        </div>
      </div>
      {config.paused && <div className="pause-banner" role="alert">Protocol operations are paused.</div>}
      <div className="metric-grid">
        <article>
          <span>Registered tasks</span>
          <strong>{(counts.task_registered ?? 0).toLocaleString()}</strong>
          <small>Indexer, refreshed now</small>
        </article>
        <article>
          <span>Executed tasks</span>
          <strong>{(counts.task_executed ?? 0).toLocaleString()}</strong>
          <small>Indexer, refreshed now</small>
        </article>
        <article>
          <span>Active keepers</span>
          <strong>{activeKeepers.toLocaleString()}</strong>
          <small>Indexer, observed history</small>
        </article>
        <article>
          <span>Fee / accrued</span>
          <strong>{config.feeBps} bps</strong>
          <small>{formatStroops(config.feesAccrued)} accrued</small>
        </article>
      </div>
      <div className="chart-grid">
        <AccessibleBars title="Tasks registered and executed" points={points} value={(point) => point.tasks} suffix=" tasks" />
        <AccessibleBars title="Rewards paid" points={points} value={(point) => Number(point.rewards)} suffix=" units" />
      </div>
    </section>
  );
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
