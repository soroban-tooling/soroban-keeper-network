import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import {
  KeeperMetrics,
  SKIP_REASONS,
  startMetricsServer,
} from "../src/metrics.js";

describe("operator metrics", () => {
  it("publishes completed-round counts, balance, duration, and typed RPC errors", async () => {
    const metrics = new KeeperMetrics();
    const round = metrics.beginRound(1_000_000_000n);
    round.evaluated(8);
    round.claimed(3);
    round.executed(2);
    for (const reason of SKIP_REASONS) {
      round.skipped(reason);
    }
    round.finish(3_500_000_000n);
    metrics.setKeeperBalance(9_000_000n);
    metrics.recordRpcError("timeout");
    metrics.recordRpcError("timeout");
    metrics.recordRpcError("simulation");

    const output = await metrics.render();
    assert.match(output, /keeper_last_round_tasks_evaluated 8/);
    assert.match(output, /keeper_last_round_tasks_claimed 3/);
    assert.match(output, /keeper_last_round_tasks_executed 2/);
    for (const reason of SKIP_REASONS) {
      assert.match(
        output,
        new RegExp(`keeper_last_round_tasks_skipped\\{reason="${reason}"\\} 1`),
      );
    }
    assert.match(output, /keeper_balance_stroops 9000000/);
    assert.match(output, /keeper_last_round_duration_seconds 2.5/);
    assert.match(output, /keeper_rpc_errors_total\{type="timeout"\} 2/);
    assert.match(output, /keeper_rpc_errors_total\{type="simulation"\} 1/);
  });

  it("replaces last-round gauges only when a round finishes", async () => {
    const metrics = new KeeperMetrics();
    const first = metrics.beginRound(0n);
    first.evaluated(5);
    first.skipped("unprofitable", 5);
    first.finish(1_000_000_000n);

    const inProgress = metrics.beginRound(2_000_000_000n);
    inProgress.evaluated(99);
    assert.match(await metrics.render(), /keeper_last_round_tasks_evaluated 5/);

    inProgress.finish(2_250_000_000n);
    const output = await metrics.render();
    assert.match(output, /keeper_last_round_tasks_evaluated 99/);
    assert.match(
      output,
      /keeper_last_round_tasks_skipped\{reason="unprofitable"\} 0/,
    );
  });

  it("serves scrapes independently over the metrics endpoint", async () => {
    const metrics = new KeeperMetrics();
    metrics.setKeeperBalance(77n);
    const server = await startMetricsServer(metrics, { port: 0 });
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /keeper_balance_stroops 77/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
