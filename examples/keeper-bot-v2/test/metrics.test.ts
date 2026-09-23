import { describe, it } from "node:test";
import assert from "node:assert";
import { MetricsCollector } from "../src/metrics.js";
import { ExecutorRegistry } from "../src/executors/registry.js";
import { TaskExecutor, TaskExecutionPayload, TaskExecutionResult } from "../src/executors/interface.js";

describe("Keeper Bot v2 Observability & Per-Task-Type Metrics", () => {
  it("tracks claimed, executed, and skipped counts broken down by task_type and aggregate totals", () => {
    const metrics = new MetricsCollector();

    metrics.recordEvaluation(10);

    metrics.recordClaim("ttl_extension");
    metrics.recordClaim("ttl_extension");
    metrics.recordClaim("contract_invocation");

    metrics.recordExecution("ttl_extension", 150000n);
    metrics.recordExecution("contract_invocation", 350000n);

    metrics.recordSkip("ttl_extension", "unprofitable");
    metrics.recordSkip("liquidation", "no_executor");
    metrics.recordSkip("liquidation", "not_claimable");

    const snap = metrics.getSnapshot();

    // Verify aggregate totals
    assert.strictEqual(snap.aggregate.tasksEvaluatedTotal, 10);
    assert.strictEqual(snap.aggregate.tasksClaimedTotal, 3);
    assert.strictEqual(snap.aggregate.tasksExecutedTotal, 2);
    assert.strictEqual(snap.aggregate.tasksSkippedTotal, 3);
    assert.strictEqual(snap.aggregate.skippedByReason["unprofitable"], 1);
    assert.strictEqual(snap.aggregate.skippedByReason["no_executor"], 1);
    assert.strictEqual(snap.aggregate.skippedByReason["not_claimable"], 1);
    assert.strictEqual(snap.aggregate.netProfitStroopsTotal, 500000n);

    // Verify breakdown by task_type
    assert.ok(snap.byTaskType["ttl_extension"]);
    assert.strictEqual(snap.byTaskType["ttl_extension"].claimedTotal, 2);
    assert.strictEqual(snap.byTaskType["ttl_extension"].executedTotal, 1);
    assert.strictEqual(snap.byTaskType["ttl_extension"].skippedTotal, 1);
    assert.strictEqual(snap.byTaskType["ttl_extension"].skippedByReason["unprofitable"], 1);
    assert.strictEqual(snap.byTaskType["ttl_extension"].netProfitStroops, 150000n);

    assert.ok(snap.byTaskType["contract_invocation"]);
    assert.strictEqual(snap.byTaskType["contract_invocation"].claimedTotal, 1);
    assert.strictEqual(snap.byTaskType["contract_invocation"].executedTotal, 1);
    assert.strictEqual(snap.byTaskType["contract_invocation"].skippedTotal, 0);
    assert.strictEqual(snap.byTaskType["contract_invocation"].netProfitStroops, 350000n);

    assert.ok(snap.byTaskType["liquidation"]);
    assert.strictEqual(snap.byTaskType["liquidation"].claimedTotal, 0);
    assert.strictEqual(snap.byTaskType["liquidation"].executedTotal, 0);
    assert.strictEqual(snap.byTaskType["liquidation"].skippedTotal, 2);
    assert.strictEqual(snap.byTaskType["liquidation"].skippedByReason["no_executor"], 1);
    assert.strictEqual(snap.byTaskType["liquidation"].skippedByReason["not_claimable"], 1);
    assert.strictEqual(snap.byTaskType["liquidation"].netProfitStroops, 0n);
  });

  it("tracks net profit per task_type accurately and distinctly", () => {
    const metrics = new MetricsCollector();

    metrics.recordExecution("oracle_update", 5000000n);
    metrics.recordExecution("oracle_update", 2500000n);
    metrics.recordExecution("yield_harvest", 12000000n);

    const snap = metrics.getSnapshot();

    assert.strictEqual(snap.aggregate.netProfitStroopsTotal, 19500000n);
    assert.strictEqual(snap.byTaskType["oracle_update"].netProfitStroops, 7500000n);
    assert.strictEqual(snap.byTaskType["yield_harvest"].netProfitStroops, 12000000n);
  });

  it("automatically provisions metrics breakdown when registering an executor without additional wiring", () => {
    const metrics = new MetricsCollector();
    const registry = new ExecutorRegistry(metrics);

    class CustomStakingExecutor implements TaskExecutor {
      public readonly taskType = "staking_slash";
      async execute(_task: TaskExecutionPayload): Promise<TaskExecutionResult> {
        return { success: true };
      }
    }

    // Register executor on the registry
    registry.register(new CustomStakingExecutor());

    // Check that metrics breakdown for 'staking_slash' was immediately initialized without any manual wiring
    const snap = metrics.getSnapshot();
    assert.ok(snap.byTaskType["staking_slash"], "Metrics entry must exist for newly registered executor");
    assert.strictEqual(snap.byTaskType["staking_slash"].claimedTotal, 0);
    assert.strictEqual(snap.byTaskType["staking_slash"].executedTotal, 0);
    assert.strictEqual(snap.byTaskType["staking_slash"].skippedTotal, 0);
    assert.strictEqual(snap.byTaskType["staking_slash"].netProfitStroops, 0n);

    // Recording operations updates the pre-wired breakdown
    metrics.recordClaim("staking_slash");
    metrics.recordExecution("staking_slash", 80000n);

    const updated = metrics.getSnapshot();
    assert.strictEqual(updated.byTaskType["staking_slash"].claimedTotal, 1);
    assert.strictEqual(updated.byTaskType["staking_slash"].executedTotal, 1);
    assert.strictEqual(updated.byTaskType["staking_slash"].netProfitStroops, 80000n);
  });

  it("formats metrics in standard Prometheus exposition format with labels", () => {
    const metrics = new MetricsCollector();
    metrics.recordClaim("contract_invocation");
    metrics.recordExecution("contract_invocation", 100000n);
    metrics.recordSkip("contract_invocation", "unprofitable");

    const prom = metrics.formatPrometheus();

    assert.ok(prom.includes('soroban_keeper_tasks_claimed_by_type{task_type="contract_invocation"} 1'));
    assert.ok(prom.includes('soroban_keeper_tasks_executed_by_type{task_type="contract_invocation"} 1'));
    assert.ok(
      prom.includes('soroban_keeper_tasks_skipped_by_type{task_type="contract_invocation",reason="unprofitable"} 1')
    );
    assert.ok(prom.includes('soroban_keeper_net_profit_stroops_by_type{task_type="contract_invocation"} 100000'));
  });
});
