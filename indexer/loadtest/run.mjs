#!/usr/bin/env node
/**
 * Load test for the keeper indexer API (issue 0242).
 *
 * Measures the REST endpoints whose cost grows with history — the aggregate
 * queries — and the WebSocket feed under concurrent subscribers, and reports
 * latency percentiles and throughput.
 *
 * The point is to establish a baseline that can be **re-run and compared**,
 * not to produce one impressive number. So the output is machine-readable, the
 * environment it ran against is recorded alongside the numbers, and the
 * scenario definitions live in this file rather than in whoever ran it last.
 *
 * Dependency-free on purpose: `fetch` and `WebSocket` are both global in
 * Node 22. A load test that needs its own install is a load test nobody re-runs.
 *
 * Usage:
 *   node run.mjs --url http://127.0.0.1:8080 --duration 30 --concurrency 32
 *   node run.mjs --json > baseline.json
 *   node run.mjs --compare BASELINE.json      # regression check against a baseline
 *
 * Exits non-zero if --compare is given and p95 regressed beyond the threshold,
 * so this can gate a release rather than only informing one.
 */

import { parseArgs } from "node:util";
import os from "node:os";
import { readFileSync } from "node:fs";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8080" },
    duration: { type: "string", default: "20" },
    concurrency: { type: "string", default: "32" },
    subscribers: { type: "string", default: "50" },
    json: { type: "boolean", default: false },
    compare: { type: "string" },
    "regression-pct": { type: "string", default: "25" },
  },
});

const BASE = values.url.replace(/\/$/, "");
const DURATION_MS = Number(values.duration) * 1000;
const CONCURRENCY = Number(values.concurrency);
const SUBSCRIBERS = Number(values.subscribers);
const REGRESSION_PCT = Number(values["regression-pct"]);

/**
 * The scenarios, heaviest first.
 *
 * `repeated` marks a scenario that sends the *same* parameters every time.
 * That is the shape the cache is meant to serve, and separating it from
 * `varied` — which deliberately misses on every request by moving `since` —
 * is what makes the cache's effect measurable rather than assumed. Comparing
 * only against an uncached build would confound the cache with everything else
 * that changed between builds.
 */
const SCENARIOS = [
  {
    name: "leaderboard:repeated",
    kind: "rest",
    repeated: true,
    path: () => "/v1/leaderboard?rank_by=executions&limit=25",
  },
  {
    name: "leaderboard:repeated-reward",
    kind: "rest",
    repeated: true,
    path: () => "/v1/leaderboard?rank_by=reward&limit=100",
  },
  {
    name: "leaderboard:varied-window",
    kind: "rest",
    repeated: false,
    // A distinct `since` per request, so every one is a cache miss and a full
    // aggregation. This is the worst case, and the number that matters for
    // capacity planning.
    path: () => `/v1/leaderboard?since=${Math.floor(Math.random() * 1_000_000)}`,
  },
  {
    name: "events:page",
    kind: "rest",
    repeated: false,
    path: () => "/v1/events?limit=100",
  },
  {
    name: "health",
    kind: "rest",
    repeated: true,
    // The control. If this moves, something changed that is not the query
    // layer, and every other number in the run should be read with suspicion.
    path: () => "/v1/health",
  },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx].toFixed(2));
}

function summarise(name, latencies, errors, elapsedMs) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    scenario: name,
    requests: latencies.length,
    errors,
    throughput_rps: Number((latencies.length / (elapsedMs / 1000)).toFixed(1)),
    latency_ms: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
    },
  };
}

/** Drive one REST scenario with `CONCURRENCY` workers for `DURATION_MS`. */
async function runRest(scenario) {
  const latencies = [];
  let errors = 0;
  const deadline = Date.now() + DURATION_MS;
  const started = Date.now();

  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}${scenario.path()}`);
        // Drain the body: measuring time-to-headers would flatter every
        // response whose cost is in serialising a large result.
        await res.arrayBuffer();
        if (!res.ok) errors += 1;
        else latencies.push(performance.now() - t0);
      } catch {
        errors += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return summarise(scenario.name, latencies, errors, Date.now() - started);
}

/**
 * Hold `SUBSCRIBERS` concurrent WebSocket connections open for the duration.
 *
 * Measures connect latency and counts frames received. The feed is push-driven,
 * so throughput here depends on what the chain does during the window — the
 * number that is actually comparable between runs is connect latency and
 * whether every subscriber stayed connected.
 */
async function runWebsocket() {
  const wsUrl = `${BASE.replace(/^http/, "ws")}/v1/stream`;
  const connectLatencies = [];
  const sockets = [];
  let frames = 0;
  let failures = 0;
  const started = Date.now();

  await Promise.all(
    Array.from({ length: SUBSCRIBERS }, async () => {
      const t0 = performance.now();
      try {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", reject, { once: true });
        });
        connectLatencies.push(performance.now() - t0);
        ws.addEventListener("message", () => {
          frames += 1;
        });
        ws.addEventListener("close", () => {
          failures += 1;
        });
        sockets.push(ws);
      } catch {
        failures += 1;
      }
    }),
  );

  await new Promise((r) => setTimeout(r, DURATION_MS));
  const held = sockets.length - failures;
  for (const ws of sockets) ws.close();

  const sorted = [...connectLatencies].sort((a, b) => a - b);
  return {
    scenario: "websocket:subscribers",
    attempted: SUBSCRIBERS,
    connected: sockets.length,
    held_to_end: held,
    frames_received: frames,
    connect_ms: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
    },
  };
}

/** Read the cache counters the API exposes, when it exposes them. */
async function cacheStats() {
  try {
    const res = await fetch(`${BASE}/v1/health`);
    if (!res.ok) return null;
    const body = await res.json();
    return body.cache ?? null;
  } catch {
    return null;
  }
}

function environment() {
  return {
    recorded_at: new Date().toISOString(),
    // Recorded because a latency number without the machine it was measured on
    // is not a baseline, it is a rumour.
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    total_memory_gb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    target: BASE,
    duration_s: DURATION_MS / 1000,
    concurrency: CONCURRENCY,
    subscribers: SUBSCRIBERS,
  };
}

function compare(current, baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const byName = new Map(baseline.rest.map((r) => [r.scenario, r]));
  const regressions = [];

  for (const result of current.rest) {
    const before = byName.get(result.scenario);
    if (!before?.latency_ms?.p95 || !result.latency_ms.p95) continue;
    const delta = ((result.latency_ms.p95 - before.latency_ms.p95) / before.latency_ms.p95) * 100;
    if (delta > REGRESSION_PCT) {
      regressions.push({
        scenario: result.scenario,
        before_p95: before.latency_ms.p95,
        after_p95: result.latency_ms.p95,
        delta_pct: Number(delta.toFixed(1)),
      });
    }
  }
  return regressions;
}

const rest = [];
for (const scenario of SCENARIOS) {
  if (!values.json) process.stderr.write(`running ${scenario.name}…\n`);
  rest.push(await runRest(scenario));
}
const websocket = await runWebsocket();

const report = {
  environment: environment(),
  rest,
  websocket,
  cache: await cacheStats(),
};

if (values.compare) {
  const regressions = compare(report, values.compare);
  report.regressions = regressions;
  if (regressions.length > 0) {
    process.stderr.write(
      `p95 regressed beyond ${REGRESSION_PCT}% in ${regressions.length} scenario(s)\n`,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(1);
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
