// ── Transport interface ────────────────────────────────────────────────

export interface AlertPayload {
  incident: string; // unique incident ID to deduplicate
  severity: "warning" | "critical";
  title: string;
  description: string;
  timestamp: string; // ISO string
  metadata: Record<string, unknown>;
}

export interface AlertTransport {
  send(payload: AlertPayload): Promise<void>;
}

// ── Reference implementation: generic webhook ─────────────────────────

export interface WebhookTransportConfig {
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class WebhookTransport implements AlertTransport {
  constructor(private config: WebhookTransportConfig) {}

  async send(payload: AlertPayload): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 5000
    );

    try {
      const response = await fetch(this.config.url, {
        method: this.config.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook responded with ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── No-op transport for testing/disabled alerts ───────────────────────

export class NoopTransport implements AlertTransport {
  async send(_payload: AlertPayload): Promise<void> {
    // intentionally does nothing
  }
}

// ── Alert rule types ──────────────────────────────────────────────────

export interface AlertRule {
  id: string;
  check(metrics: KeeperMetrics): AlertPayload | null;
}

export interface KeeperMetrics {
  // From issue 0257 — use actual metric names from that implementation
  claimedTasks: Map<string, { claimedAt: Date; executed: boolean }>;
  consecutiveRpcErrors: number;
  keeperBalance: bigint;
  previousKeeperBalance: bigint;
  claimedActivityCount: number;
  roundsWithRpcErrors: number;
}

// ── Alert manager with deduplication ─────────────────────────────────

export class AlertManager {
  private transport: AlertTransport;
  private rules: AlertRule[];
  private activeIncidents: Set<string> = new Set();

  constructor(transport: AlertTransport, rules: AlertRule[]) {
    this.transport = transport;
    this.rules = rules;
  }

  /**
   * Evaluate all rules against current metrics.
   * Fires exactly ONE notification per incident, not a flood.
   * Once an incident clears, it can fire again if it recurs.
   */
  async evaluate(metrics: KeeperMetrics): Promise<void> {
    for (const rule of this.rules) {
      const payload = rule.check(metrics);

      if (payload) {
        // New incident — fire once
        if (!this.activeIncidents.has(payload.incident)) {
          this.activeIncidents.add(payload.incident);
          await this.transport.send(payload).catch((err) => {
            // Transport failure must not crash the keeper bot
            console.error(
              `Alert transport failed for incident ${payload.incident}:`,
              err.message
            );
          });
        }
        // Ongoing incident — do nothing (deduplication)
      } else {
        // Incident cleared — remove from active so it can re-trigger
        this.activeIncidents.delete(rule.id);
      }
    }
  }

  // For testing
  getActiveIncidents(): Set<string> {
    return new Set(this.activeIncidents);
  }

  clearIncident(incidentId: string): void {
    this.activeIncidents.delete(incidentId);
  }
}

// ── Built-in alert rules ──────────────────────────────────────────────

export interface MissedExecutionRuleConfig {
  lockWindowMs: number; // how long a claimed task has to be executed
}

/**
 * Rule 1: A claimed task was never executed within its lock window.
 */
export class MissedExecutionRule implements AlertRule {
  id = "missed-execution";

  constructor(private config: MissedExecutionRuleConfig) {}

  check(metrics: KeeperMetrics): AlertPayload | null {
    const now = Date.now();
    const missedTasks: string[] = [];

    for (const [taskId, task] of metrics.claimedTasks) {
      const elapsed = now - task.claimedAt.getTime();
      if (!task.executed && elapsed > this.config.lockWindowMs) {
        missedTasks.push(taskId);
      }
    }

    if (missedTasks.length === 0) return null;

    return {
      incident: `${this.id}:${missedTasks.sort().join(",")}`,
      severity: "critical",
      title: "Missed Task Execution",
      description: `${missedTasks.length} claimed task(s) not executed within lock window: ${missedTasks.join(", ")}`,
      timestamp: new Date().toISOString(),
      metadata: { missedTasks, lockWindowMs: this.config.lockWindowMs },
    };
  }
}

export interface ConsecutiveRpcErrorRuleConfig {
  threshold: number; // how many consecutive rounds with RPC errors before alerting
}

/**
 * Rule 2: A run of consecutive rounds with RPC errors.
 */
export class ConsecutiveRpcErrorRule implements AlertRule {
  id = "consecutive-rpc-errors";

  constructor(private config: ConsecutiveRpcErrorRuleConfig) {}

  check(metrics: KeeperMetrics): AlertPayload | null {
    if (metrics.consecutiveRpcErrors < this.config.threshold) return null;

    return {
      incident: this.id,
      severity: "critical",
      title: "Persistent RPC Errors",
      description: `${metrics.consecutiveRpcErrors} consecutive rounds with RPC errors (threshold: ${this.config.threshold})`,
      timestamp: new Date().toISOString(),
      metadata: {
        consecutiveRpcErrors: metrics.consecutiveRpcErrors,
        threshold: this.config.threshold,
      },
    };
  }
}

/**
 * Rule 3: Keeper balance not growing despite claimed activity.
 */
export class StagnantBalanceRule implements AlertRule {
  id = "stagnant-balance";

  check(metrics: KeeperMetrics): AlertPayload | null {
    // Only alert if there WAS claimed activity but balance did NOT grow
    if (metrics.claimedActivityCount === 0) return null;

    if (metrics.keeperBalance > metrics.previousKeeperBalance) return null;

    return {
      incident: this.id,
      severity: "warning",
      title: "Keeper Balance Not Growing",
      description: `Keeper claimed ${metrics.claimedActivityCount} task(s) but balance did not increase. Possible reward delivery issue.`,
      timestamp: new Date().toISOString(),
      metadata: {
        currentBalance: metrics.keeperBalance.toString(),
        previousBalance: metrics.previousKeeperBalance.toString(),
        claimedActivityCount: metrics.claimedActivityCount,
      },
    };
  }
}

// ── Factory function ──────────────────────────────────────────────────

export interface AlertConfig {
  webhook?: WebhookTransportConfig;
  missedExecution?: { lockWindowMs: number };
  consecutiveRpcErrors?: { threshold: number };
  stagnantBalance?: { enabled: boolean };
}

export function createAlertManager(config: AlertConfig): AlertManager {
  const transport = config.webhook
    ? new WebhookTransport(config.webhook)
    : new NoopTransport();

  const rules: AlertRule[] = [];

  if (config.missedExecution) {
    rules.push(new MissedExecutionRule(config.missedExecution));
  }

  if (config.consecutiveRpcErrors) {
    rules.push(new ConsecutiveRpcErrorRule(config.consecutiveRpcErrors));
  }

  if (config.stagnantBalance?.enabled !== false) {
    rules.push(new StagnantBalanceRule());
  }

  return new AlertManager(transport, rules);
}
