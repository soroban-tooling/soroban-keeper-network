# Indexer load test

Repeatable load test for the keeper indexer API, and the baseline it produces.

Implements issue 0242. The baseline itself lives in [`BASELINE.md`](BASELINE.md),
with the raw report in [`BASELINE.json`](BASELINE.json).

The server to point it at is `indexer/tests/loadtest_server.rs`, an `#[ignore]`d
test that seeds a realistic event history and serves the real router over the
real store — so the measurement is of the indexer, not of a stub.

## Why this exists

Before the API is relied on by the dashboard and by third parties, its capacity
under realistic query load should be **measured rather than assumed**. Equally
important, the measurement has to be repeatable: a number produced once by
whoever happened to run it is not something a later change can be compared
against.

So the scenarios live in `run.mjs` rather than in someone's shell history, the
environment is recorded alongside every result, and `--compare` turns the
baseline into a gate rather than a document.

## Running it

Node 22+, no install step — `fetch` and `WebSocket` are both global, and a load
test that needs its own dependency tree is a load test nobody re-runs.

```bash
# start a seeded indexer (see indexer/tests/loadtest_server.rs)
LOADTEST_EVENTS=2000 LOADTEST_SECS=420 \
  cargo test -p keeper-indexer --test loadtest_server -- --ignored --nocapture &

# against it
node run.mjs --url http://127.0.0.1:8080

# record a baseline
node run.mjs --json > BASELINE.json

# check a change against it; exits non-zero on a regression
node run.mjs --compare BASELINE.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://127.0.0.1:8080` | Indexer base URL |
| `--duration` | `20` | Seconds per scenario |
| `--concurrency` | `32` | Concurrent REST workers |
| `--subscribers` | `50` | Concurrent WebSocket subscribers |
| `--json` | off | Report only on stdout; progress to stderr |
| `--compare` | — | Baseline JSON to compare against |
| `--regression-pct` | `25` | p95 increase that counts as a regression |

## The scenarios

Heaviest first. The split between *repeated* and *varied* parameters is the
part that matters:

| Scenario | Parameters | What it measures |
|---|---|---|
| `leaderboard:repeated` | identical every request | The cached path — what dashboard traffic actually looks like |
| `leaderboard:repeated-reward` | identical, `limit=100` | The same, with a larger result to serialise |
| `leaderboard:varied-window` | a new `since` every request | **Every request misses.** Full aggregation, the worst case, the number for capacity planning |
| `events:page` | cursor page of 100 | The heaviest non-aggregate read |
| `health` | trivial | The control — if this moves, something outside the query layer changed |

Comparing `leaderboard:repeated` against `leaderboard:varied-window` in **one
run** is what isolates the cache's effect. Comparing against an uncached build
instead would confound the cache with everything else that differs between two
builds.

The body of every response is drained before the timer stops: measuring
time-to-headers would flatter exactly the responses whose cost is in
serialising a large result.

## Testing the test

```bash
node --test
```

Six tests run the real script against a stub indexer and assert the report is
well-formed, the environment is recorded, error counting works against a
degraded server, and `--compare` both fails on a regression and passes without
one.
