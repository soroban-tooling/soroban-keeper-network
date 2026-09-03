# Indexer API baseline

Produced by [`run.mjs`](run.mjs). Re-run it and replace this file rather than
editing numbers by hand — the point of the baseline is that it is reproducible.

The raw report is committed alongside as [`BASELINE.json`](BASELINE.json), which
is what `run.mjs --compare BASELINE.json` reads.

---

## Environment

| | |
|---|---|
| Recorded | 2026-08-30 |
| CPU | Intel Core i5-6300U @ 2.40GHz, 4 cores |
| Memory | 15.5 GB |
| Platform | Linux 7.1.4 x86_64 |
| Node | v24.18.0 |
| Build | `cargo test` **debug profile** — see the caveat below |
| Store | SQLite in-memory |
| Dataset | 2,000 tasks → **4,000 events** (2,000 `registered` + 2,000 `executed`) across 250 keepers |
| Load | 8s per scenario, 16 concurrent REST workers, 25 WebSocket subscribers |

> **Debug build.** A release build could not be produced in the measurement
> environment (`utoipa-swagger-ui`'s build script downloads swagger-ui from
> GitHub at build time, which was unavailable). Absolute numbers are therefore
> pessimistic — a release build will be materially faster. **The cached vs
> uncached comparison below is unaffected**, since both sides were measured on
> the same build, and that comparison is what this baseline exists to establish.

Reproduce it with:

```bash
LOADTEST_EVENTS=2000 LOADTEST_PORT=8080 LOADTEST_SECS=420 LOADTEST_CACHE_TTL_SECS=10 \
  cargo test -p keeper-indexer --test loadtest_server -- --ignored --nocapture &
node indexer/loadtest/run.mjs --duration 8 --concurrency 16 --subscribers 25 --json > BASELINE.json
```

---

## REST results

| Scenario | req/s | p50 (ms) | p95 (ms) | p99 (ms) | errors |
|---|---|---|---|---|---|
| `leaderboard:repeated` | 296.7 | 33.32 | 93.97 | 346.13 | 0 |
| `leaderboard:repeated-reward` | 102.5 | 85.82 | 442.81 | 1206.45 | 0 |
| `leaderboard:varied-window` | 8.2 | 1893.20 | 2213.88 | 2277.09 | 0 |
| `events:page` | 56.2 | 266.50 | 396.80 | 548.35 | 0 |
| `health` | 617.3 | 22.36 | 45.45 | 93.96 | 0 |

**`leaderboard:varied-window` is the capacity number.** Every request there is a
distinct `since`, so every one is a full aggregation over the whole event log:
**8.2 req/s** on this dataset, on this machine, in a debug build. That is the
figure to watch as history grows — it scales with the row count, and it is what
an uncacheable query pattern actually costs.

## WebSocket results

| Attempted | Connected | Held to end | Connect p50 (ms) | Connect p95 (ms) |
|---|---|---|---|---|
| 25 | 25 | 25 | 115.29 | 129.92 |

Every subscriber connected and none dropped.

---

## Does the cache help?

Yes — **63× on the path it is meant to serve, and not at all on the path it is
not**, which is the result that makes it credible.

Measured as a controlled A/B: the same scenarios, the same seeded dataset, the
same build, run twice — once with `LOADTEST_CACHE_TTL_SECS=10` and once with
`0` (caching off).

| Scenario | Cached req/s | Uncached req/s | Factor | Cached p95 | Uncached p95 |
|---|---|---|---|---|---|
| `leaderboard:repeated` | **296.7** | 4.7 | **63.1×** | 93.97 ms | 4012.21 ms |
| `leaderboard:repeated-reward` | 102.5 | 6.2 | 16.5× | 442.81 ms | 3229.80 ms |
| `leaderboard:varied-window` | 8.2 | 7.4 | **1.1×** | 2213.88 ms | 2468.81 ms |
| `events:page` | 56.2 | 49.0 | 1.1× | 396.80 ms | 484.13 ms |
| `health` | 617.3 | 280.6 | 2.2× | 45.45 ms | 105.71 ms |

Three things in that table, and the last two matter more than the first:

1. **`leaderboard:repeated` gains 63×** — 4.7 → 296.7 req/s, p50 3218 ms →
   33 ms. That is the dashboard's actual traffic shape: many viewers asking the
   same question inside a few seconds.
2. **`leaderboard:varied-window` gains 1.1×, i.e. nothing.** Every request there
   misses by construction. A cache that also "improved" this number would be
   measuring noise, or lying. It is the control, and it behaving as a control is
   what licenses reading row 1 as a real effect.
3. **`health` gains 2.2×** — it is not cached, so this is contention, not
   caching: under the uncached run the server is saturated by aggregation work
   and every other endpoint suffers. That is the second-order cost the cache
   removes, and it is only visible because a trivial control endpoint was
   included in the run.

Cache counters were not read from `/v1/health` — the endpoint does not expose
the `cache` block yet, so the report's `cache` field is `null`. The comparison
above does not depend on it.

---

## Method

- Each REST scenario runs for `--duration` seconds at `--concurrency` workers.
- Response bodies are fully drained before the timer stops, so serialisation
  cost is included rather than hidden behind time-to-headers.
- WebSocket subscribers connect concurrently and are held for the full duration.
- Latency is p50 / p95 / p99 / max; throughput is completed requests per second.
- `run.mjs --compare BASELINE.json` re-runs this and exits non-zero if p95
  regresses more than `--regression-pct` (default 25%) in any scenario.
