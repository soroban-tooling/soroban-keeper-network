import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "run.mjs");

/**
 * A stub indexer, so the harness itself is tested rather than assumed.
 *
 * A load test that has never been run against anything is not a repeatable
 * measurement, it is a file. This starts a server that answers every route the
 * scenarios hit, runs the real script against it, and checks the report is
 * well-formed and the comparison logic actually fires.
 */
async function stubIndexer({ delayMs = 0 } = {}) {
  const server = createServer((req, res) => {
    const respond = () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/v1/health")) {
        res.end(JSON.stringify({ status: "ok", cache: { hits: 9, misses: 1 } }));
      } else if (req.url?.startsWith("/v1/leaderboard")) {
        res.end(JSON.stringify({ rank_by: "executions", since: null, entries: [] }));
      } else {
        res.end(JSON.stringify({ events: [], next_cursor: null }));
      }
    };
    if (delayMs) setTimeout(respond, delayMs);
    else respond();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runHarness(url, extra = []) {
  const { stdout } = await run(
    process.execPath,
    [script, "--url", url, "--duration", "1", "--concurrency", "4", "--subscribers", "0", "--json", ...extra],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test("produces a well-formed report against a running server", async () => {
  const stub = await stubIndexer();
  try {
    const report = await runHarness(stub.url);

    // Every scenario ran and produced requests.
    const names = report.rest.map((r) => r.scenario);
    assert.deepEqual(names, [
      "leaderboard:repeated",
      "leaderboard:repeated-reward",
      "leaderboard:varied-window",
      "events:page",
      "health",
    ]);
    for (const result of report.rest) {
      assert.ok(result.requests > 0, `${result.scenario} sent no requests`);
      assert.equal(result.errors, 0);
      assert.ok(result.throughput_rps > 0);
      assert.ok(result.latency_ms.p95 >= result.latency_ms.p50);
      assert.ok(result.latency_ms.p99 >= result.latency_ms.p95);
    }
  } finally {
    await stub.close();
  }
});

test("records the environment the numbers were measured on", async () => {
  const stub = await stubIndexer();
  try {
    const report = await runHarness(stub.url);
    // A latency number without the machine it came from is not a baseline.
    for (const key of ["node", "platform", "cpu", "cores", "total_memory_gb", "target", "duration_s", "concurrency"]) {
      assert.ok(report.environment[key] !== undefined, `environment.${key} missing`);
    }
    assert.equal(report.environment.target, stub.url);
  } finally {
    await stub.close();
  }
});

test("surfaces the cache counters the API reports", async () => {
  const stub = await stubIndexer();
  try {
    const report = await runHarness(stub.url);
    assert.deepEqual(report.cache, { hits: 9, misses: 1 });
  } finally {
    await stub.close();
  }
});

test("counts errors instead of aborting when the server misbehaves", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const report = await runHarness(`http://127.0.0.1:${port}`);
    // A run against a degraded server must still produce a report saying so.
    assert.ok(report.rest.every((r) => r.errors > 0));
    assert.ok(report.rest.every((r) => r.requests === 0));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("--compare fails the run when p95 regresses beyond the threshold", async () => {
  // A slow server measured against a fast baseline: the comparison must exit
  // non-zero, or this can inform a release but never gate one.
  const stub = await stubIndexer({ delayMs: 25 });
  const dir = mkdtempSync(join(tmpdir(), "loadtest-"));
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({
      rest: [
        { scenario: "leaderboard:repeated", latency_ms: { p95: 0.5 } },
        { scenario: "health", latency_ms: { p95: 0.5 } },
      ],
    }),
  );

  try {
    await assert.rejects(
      runHarness(stub.url, ["--compare", baselinePath]),
      (err) => {
        assert.equal(err.code, 1);
        const report = JSON.parse(err.stdout);
        assert.ok(report.regressions.length > 0);
        assert.ok(report.regressions.every((r) => r.delta_pct > 25));
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("--compare passes when nothing regressed", async () => {
  const stub = await stubIndexer();
  const dir = mkdtempSync(join(tmpdir(), "loadtest-"));
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({
      rest: [{ scenario: "leaderboard:repeated", latency_ms: { p95: 10_000 } }],
    }),
  );

  try {
    const report = await runHarness(stub.url, ["--compare", baselinePath]);
    assert.deepEqual(report.regressions, []);
  } finally {
    await stub.close();
  }
});
