/**
 * Tests for the opt-in metrics endpoint added in issue #717.
 *
 * The important properties here are that metric names agree with the v2 bot,
 * that labels stay bounded, and that error messages never reach the exposition
 * (an RPC URL can carry an API key).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const {
  MetricsCollector,
  classifyError,
  escapeLabel,
  startMetricsServer,
} = require("../metrics.js");

function exposition(collector) {
  return collector.render();
}

function scrape(server) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    http
      .get(`http://127.0.0.1:${address.port}/metrics`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("classifyError", () => {
  it("maps common failures to a bounded set", () => {
    assert.equal(classifyError(new Error("Request timed out")), "timeout");
    assert.equal(classifyError(new Error("ECONNREFUSED")), "network");
    assert.equal(classifyError(new Error("429 rate limit exceeded")), "rate_limit");
    assert.equal(classifyError(new Error("simulation failed: unauthorized")), "contract");
    assert.equal(classifyError(new Error("something novel happened")), "unknown");
  });

  it("never echoes a URL or message into the label value", () => {
    const err = new Error("GET https://user:key@rpc.example.com/api?token=secret failed");
    assert.equal(classifyError(err), "unknown");
    assert.ok(!exposition(new MetricsCollector()).includes("secret"));
  });
});

describe("MetricsCollector", () => {
  it("renders every documented family with HELP and TYPE", () => {
    const collector = new MetricsCollector();
    collector.recordRound();
    collector.recordEvaluation(3);
    collector.recordClaim();
    collector.recordExecution();
    collector.recordSkip("expired");
    collector.recordRpcError("timeout");

    const body = exposition(collector);
    for (const name of [
      "soroban_keeper_rounds_total",
      "soroban_keeper_tasks_evaluated_total",
      "soroban_keeper_tasks_claimed_total",
      "soroban_keeper_tasks_executed_total",
      "soroban_keeper_tasks_skipped_total",
      "soroban_keeper_rpc_errors_total",
    ]) {
      assert.ok(body.includes(`# HELP ${name} `), `missing HELP for ${name}`);
      assert.ok(body.includes(`# TYPE ${name} counter`), `missing TYPE for ${name}`);
    }
    assert.ok(body.includes('soroban_keeper_tasks_skipped_total{reason="expired"} 1'));
    assert.ok(body.includes('soroban_keeper_rpc_errors_total{error_type="timeout"} 1'));
  });

  it("matches the v2 names where the meaning is the same", () => {
    const body = exposition(new MetricsCollector());
    for (const name of [
      "soroban_keeper_tasks_evaluated_total",
      "soroban_keeper_tasks_claimed_total",
      "soroban_keeper_tasks_executed_total",
      "soroban_keeper_tasks_skipped_total",
      "soroban_keeper_rpc_errors_total",
    ]) {
      assert.ok(body.includes(name), `${name} must match keeper-bot-v2`);
    }
  });

  it("keeps skip and error labels bounded", () => {
    const collector = new MetricsCollector();
    collector.recordSkip("expired");
    collector.recordSkip("some_task_12345");
    collector.recordRpcError(new Error("task 42 failed with xyz"));
    const body = exposition(collector);
    assert.ok(body.includes('reason="other"'));
    assert.ok(!body.includes("12345"));
    assert.ok(!body.includes("xyz"));
  });

  it("escapes label values", () => {
    assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  });

  it("produces stable output regardless of insertion order", () => {
    const a = new MetricsCollector();
    const b = new MetricsCollector();
    a.recordSkip("expired");
    a.recordSkip("unprofitable");
    b.recordSkip("unprofitable");
    b.recordSkip("expired");
    assert.equal(a.render(), b.render());
  });
});

describe("startMetricsServer", () => {
  it("serves /metrics on loopback and 404s everything else", async () => {
    const collector = new MetricsCollector();
    collector.recordRound();
    const server = startMetricsServer(collector, 0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert.equal(address.address, "127.0.0.1");
      const metrics = await scrape(server);
      assert.equal(metrics.status, 200);
      assert.ok(metrics.body.includes("soroban_keeper_rounds_total 1"));

      const notFound = await new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${address.port}/other`, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          })
          .on("error", reject);
      });
      assert.equal(notFound, 404);
    } finally {
      await close(server);
    }
  });
});
