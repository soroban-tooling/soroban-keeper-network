import http from "node:http";

export interface TaskTypeMetrics {
  taskType: string;
  claimedTotal: number;
  executedTotal: number;
  skippedTotal: number;
  skippedByReason: Record<string, number>;
  netProfitStroops: bigint;
}

export interface AggregateMetrics {
  tasksEvaluatedTotal: number;
  tasksClaimedTotal: number;
  tasksExecutedTotal: number;
  tasksSkippedTotal: number;
  skippedByReason: Record<string, number>;
  netProfitStroopsTotal: bigint;
  roundDurationSeconds: number;
  keeperBalances: Record<string, bigint>;
  rpcErrorsTotal: Record<string, number>;
}

export interface MetricsSnapshot {
  aggregate: AggregateMetrics;
  byTaskType: Record<string, TaskTypeMetrics>;
}

export class MetricsCollector {
  private evaluatedTotal = 0;
  private claimedTotal = 0;
  private executedTotal = 0;
  private skippedTotal = 0;
  private aggregateSkippedByReason: Record<string, number> = {};
  private netProfitTotal = 0n;
  private roundDuration = 0;
  private keeperBalances: Record<string, bigint> = {};
  private rpcErrors: Record<string, number> = {};

  private taskTypeMetrics: Map<string, TaskTypeMetrics> = new Map();

  constructor() {}

  /**
   * Automatically initializes zeroed metrics for a given task_type when
   * an executor for that type is registered.
   */
  public registerExecutor(taskType: string): void {
    this.ensureTaskType(taskType);
  }

  /**
   * Internal helper ensuring that any task type has a zeroed metrics entry.
   */
  public ensureTaskType(taskType: string): TaskTypeMetrics {
    let entry = this.taskTypeMetrics.get(taskType);
    if (!entry) {
      entry = {
        taskType,
        claimedTotal: 0,
        executedTotal: 0,
        skippedTotal: 0,
        skippedByReason: {},
        netProfitStroops: 0n,
      };
      this.taskTypeMetrics.set(taskType, entry);
    }
    return entry;
  }

  public recordEvaluation(count = 1): void {
    this.evaluatedTotal += count;
  }

  public recordClaim(taskType: string): void {
    this.claimedTotal += 1;
    const tt = this.ensureTaskType(taskType);
    tt.claimedTotal += 1;
  }

  public recordExecution(taskType: string, profitStroops: bigint): void {
    this.executedTotal += 1;
    this.netProfitTotal += profitStroops;

    const tt = this.ensureTaskType(taskType);
    tt.executedTotal += 1;
    tt.netProfitStroops += profitStroops;
  }

  public recordSkip(taskType: string, reason: string): void {
    this.skippedTotal += 1;
    this.aggregateSkippedByReason[reason] = (this.aggregateSkippedByReason[reason] || 0) + 1;

    const tt = this.ensureTaskType(taskType);
    tt.skippedTotal += 1;
    tt.skippedByReason[reason] = (tt.skippedByReason[reason] || 0) + 1;
  }

  public recordRpcError(errorType: string): void {
    this.rpcErrors[errorType] = (this.rpcErrors[errorType] || 0) + 1;
  }

  public setKeeperBalance(address: string, balanceStroops: bigint): void {
    this.keeperBalances[address] = balanceStroops;
  }

  public setRoundDuration(durationSeconds: number): void {
    this.roundDuration = durationSeconds;
  }

  public getSnapshot(): MetricsSnapshot {
    const byType: Record<string, TaskTypeMetrics> = {};
    for (const [k, v] of this.taskTypeMetrics.entries()) {
      byType[k] = {
        ...v,
        skippedByReason: { ...v.skippedByReason },
      };
    }

    return {
      aggregate: {
        tasksEvaluatedTotal: this.evaluatedTotal,
        tasksClaimedTotal: this.claimedTotal,
        tasksExecutedTotal: this.executedTotal,
        tasksSkippedTotal: this.skippedTotal,
        skippedByReason: { ...this.aggregateSkippedByReason },
        netProfitStroopsTotal: this.netProfitTotal,
        roundDurationSeconds: this.roundDuration,
        keeperBalances: { ...this.keeperBalances },
        rpcErrorsTotal: { ...this.rpcErrors },
      },
      byTaskType: byType,
    };
  }

  /**
   * Formats metrics in Prometheus exposition format.
   * Produces aggregate totals as well as breakdown metrics by task_type and skip reason.
   */
  public formatPrometheus(): string {
    const lines: string[] = [];

    // Evaluated
    lines.push("# HELP soroban_keeper_tasks_evaluated_total Total candidate tasks evaluated.");
    lines.push("# TYPE soroban_keeper_tasks_evaluated_total counter");
    lines.push(`soroban_keeper_tasks_evaluated_total ${this.evaluatedTotal}`);

    // Claimed
    lines.push("# HELP soroban_keeper_tasks_claimed_total Total tasks claimed by the keeper.");
    lines.push("# TYPE soroban_keeper_tasks_claimed_total counter");
    lines.push(`soroban_keeper_tasks_claimed_total ${this.claimedTotal}`);
    for (const [taskType, m] of this.taskTypeMetrics.entries()) {
      lines.push(`soroban_keeper_tasks_claimed_by_type{task_type="${escapeLabel(taskType)}"} ${m.claimedTotal}`);
    }

    // Executed
    lines.push("# HELP soroban_keeper_tasks_executed_total Total tasks successfully executed.");
    lines.push("# TYPE soroban_keeper_tasks_executed_total counter");
    lines.push(`soroban_keeper_tasks_executed_total ${this.executedTotal}`);
    for (const [taskType, m] of this.taskTypeMetrics.entries()) {
      lines.push(`soroban_keeper_tasks_executed_by_type{task_type="${escapeLabel(taskType)}"} ${m.executedTotal}`);
    }

    // Skipped
    lines.push("# HELP soroban_keeper_tasks_skipped_total Total tasks skipped.");
    lines.push("# TYPE soroban_keeper_tasks_skipped_total counter");
    lines.push(`soroban_keeper_tasks_skipped_total ${this.skippedTotal}`);
    for (const [reason, count] of Object.entries(this.aggregateSkippedByReason)) {
      lines.push(`soroban_keeper_tasks_skipped_total{reason="${escapeLabel(reason)}"} ${count}`);
    }
    for (const [taskType, m] of this.taskTypeMetrics.entries()) {
      lines.push(`soroban_keeper_tasks_skipped_by_type{task_type="${escapeLabel(taskType)}"} ${m.skippedTotal}`);
      for (const [reason, count] of Object.entries(m.skippedByReason)) {
        lines.push(
          `soroban_keeper_tasks_skipped_by_type{task_type="${escapeLabel(taskType)}",reason="${escapeLabel(reason)}"} ${count}`
        );
      }
    }

    // Net Profit
    lines.push("# HELP soroban_keeper_net_profit_stroops_total Net profit in stroops earned across executions.");
    lines.push("# TYPE soroban_keeper_net_profit_stroops_total counter");
    lines.push(`soroban_keeper_net_profit_stroops_total ${this.netProfitTotal.toString()}`);
    for (const [taskType, m] of this.taskTypeMetrics.entries()) {
      lines.push(
        `soroban_keeper_net_profit_stroops_by_type{task_type="${escapeLabel(taskType)}"} ${m.netProfitStroops.toString()}`
      );
    }

    // Round Duration
    lines.push("# HELP soroban_keeper_round_duration_seconds Duration of the latest polling round in seconds.");
    lines.push("# TYPE soroban_keeper_round_duration_seconds gauge");
    lines.push(`soroban_keeper_round_duration_seconds ${this.roundDuration.toFixed(3)}`);

    // Balances
    if (Object.keys(this.keeperBalances).length > 0) {
      lines.push("# HELP soroban_keeper_balance_stroops Current on-chain keeper balance in stroops.");
      lines.push("# TYPE soroban_keeper_balance_stroops gauge");
      for (const [addr, bal] of Object.entries(this.keeperBalances)) {
        lines.push(`soroban_keeper_balance_stroops{address="${escapeLabel(addr)}"} ${bal.toString()}`);
      }
    }

    // RPC Errors
    if (Object.keys(this.rpcErrors).length > 0) {
      lines.push("# HELP soroban_keeper_rpc_errors_total Count of RPC errors encountered by type.");
      lines.push("# TYPE soroban_keeper_rpc_errors_total counter");
      for (const [errType, count] of Object.entries(this.rpcErrors)) {
        lines.push(`soroban_keeper_rpc_errors_total{error_type="${escapeLabel(errType)}"} ${count}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  public toJson(): string {
    const snap = this.getSnapshot();
    return JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  }
}

function escapeLabel(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function startMetricsServer(collector: MetricsCollector, port = 9090): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(collector.formatPrometheus());
    } else if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    // Started
  });

  return server;
}
