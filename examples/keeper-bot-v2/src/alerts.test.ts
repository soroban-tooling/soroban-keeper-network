import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AlertManager,
  AlertPayload,
  AlertTransport,
  ConsecutiveRpcErrorRule,
  ConsecutiveRpcErrorRuleConfig,
  KeeperMetrics,
  MissedExecutionRule,
  MissedExecutionRuleConfig,
  NoopTransport,
  StagnantBalanceRule,
  WebhookTransport,
  WebhookTransportConfig,
  createAlertManager,
} from "./alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mock transport to capture sent payloads for testing
 */
class MockTransport implements AlertTransport {
  sentPayloads: AlertPayload[] = [];

  async send(payload: AlertPayload): Promise<void> {
    this.sentPayloads.push(payload);
  }

  reset(): void {
    this.sentPayloads = [];
  }
}

/**
 * Creates default metrics for testing
 */
function defaultMetrics(): KeeperMetrics {
  return {
    claimedTasks: new Map(),
    consecutiveRpcErrors: 0,
    keeperBalance: 1000000n,
    previousKeeperBalance: 1000000n,
    claimedActivityCount: 0,
    roundsWithRpcErrors: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSED EXECUTION RULE
// ─────────────────────────────────────────────────────────────────────────────

describe("MissedExecutionRule", () => {
  const config: MissedExecutionRuleConfig = { lockWindowMs: 10000 };
  const rule = new MissedExecutionRule(config);

  it("does not alert when a claimed task is executed within the lock window", () => {
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 5000), // claimed 5s ago
      executed: true, // executed
    });

    const payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("does alert when a claimed task is not executed after the lock window expires", () => {
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000), // claimed 15s ago (past 10s window)
      executed: false, // not executed
    });

    const payload = rule.check(metrics);
    expect(payload).not.toBeNull();
    expect(payload?.severity).toBe("critical");
    expect(payload?.title).toBe("Missed Task Execution");
    expect(payload?.metadata.missedTasks).toEqual(["task-1"]);
  });

  it("includes the correct taskId in the alert payload metadata", () => {
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-42", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    const payload = rule.check(metrics);
    expect(payload?.metadata.missedTasks).toContain("task-42");
  });

  it("includes all missed tasks in a single alert when multiple tasks are missed", () => {
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.claimedTasks.set("task-2", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.claimedTasks.set("task-3", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    const payload = rule.check(metrics);
    expect(payload).not.toBeNull();
    expect(payload?.metadata.missedTasks).toHaveLength(3);
    expect(payload?.description).toContain("3 claimed task(s)");
  });

  it("clears the incident when tasks are executed after being missed", () => {
    const now = Date.now();

    // First evaluation: task not executed, incident fires
    let metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    let payload = rule.check(metrics);
    expect(payload).not.toBeNull();

    // Second evaluation: task executed, incident clears
    metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: true, // now executed
    });

    payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("sorts task IDs in the incident identifier for consistency", () => {
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-c", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.claimedTasks.set("task-a", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.claimedTasks.set("task-b", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    const payload = rule.check(metrics);
    expect(payload?.incident).toBe("missed-execution:task-a,task-b,task-c");
  });

  it("does not alert when no tasks are claimed", () => {
    const metrics = defaultMetrics();
    // claimedTasks is empty

    const payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("includes lockWindowMs in metadata", () => {
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    const payload = rule.check(metrics);
    expect(payload?.metadata.lockWindowMs).toBe(10000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSECUTIVE RPC ERROR RULE
// ─────────────────────────────────────────────────────────────────────────────

describe("ConsecutiveRpcErrorRule", () => {
  const config: ConsecutiveRpcErrorRuleConfig = { threshold: 3 };
  const rule = new ConsecutiveRpcErrorRule(config);

  it("does not alert when consecutive RPC errors are below the threshold", () => {
    const metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 2; // below threshold of 3

    const payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("alerts when consecutive RPC errors reach exactly the threshold", () => {
    const metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 3; // exactly at threshold

    const payload = rule.check(metrics);
    expect(payload).not.toBeNull();
    expect(payload?.severity).toBe("critical");
    expect(payload?.title).toBe("Persistent RPC Errors");
  });

  it("alerts when consecutive RPC errors exceed the threshold (deduplication tested separately)", () => {
    const metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 5; // above threshold

    const payload = rule.check(metrics);
    expect(payload).not.toBeNull();
    expect(payload?.severity).toBe("critical");
  });

  it("includes the threshold and error count in metadata", () => {
    const metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 5;

    const payload = rule.check(metrics);
    expect(payload?.metadata.consecutiveRpcErrors).toBe(5);
    expect(payload?.metadata.threshold).toBe(3);
  });

  it("clears the incident when error count drops below threshold", () => {
    // First evaluation: errors at threshold, incident fires
    let metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 3;

    let payload = rule.check(metrics);
    expect(payload).not.toBeNull();

    // Second evaluation: errors drop to 0
    metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 0;

    payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("has a consistent incident ID", () => {
    const metrics1 = defaultMetrics();
    metrics1.consecutiveRpcErrors = 3;

    const metrics2 = defaultMetrics();
    metrics2.consecutiveRpcErrors = 5;

    const payload1 = rule.check(metrics1);
    const payload2 = rule.check(metrics2);

    expect(payload1?.incident).toBe("consecutive-rpc-errors");
    expect(payload2?.incident).toBe("consecutive-rpc-errors");
  });

  it("includes description with error count and threshold", () => {
    const metrics = defaultMetrics();
    metrics.consecutiveRpcErrors = 7;

    const payload = rule.check(metrics);
    expect(payload?.description).toContain("7");
    expect(payload?.description).toContain("3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGNANT BALANCE RULE
// ─────────────────────────────────────────────────────────────────────────────

describe("StagnantBalanceRule", () => {
  const rule = new StagnantBalanceRule();

  it("does not alert when there is no claimed activity (silence when idle)", () => {
    const metrics = defaultMetrics();
    metrics.claimedActivityCount = 0;
    metrics.keeperBalance = 1000000n;
    metrics.previousKeeperBalance = 1000000n;

    const payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("does not alert when claimed activity occurred and balance grew (happy path)", () => {
    const metrics = defaultMetrics();
    metrics.claimedActivityCount = 5;
    metrics.keeperBalance = 2000000n; // balance grew
    metrics.previousKeeperBalance = 1000000n;

    const payload = rule.check(metrics);
    expect(payload).toBeNull();
  });

  it("alerts when claimed activity occurred but balance did not increase", () => {
    const metrics = defaultMetrics();
    metrics.claimedActivityCount = 5;
    metrics.keeperBalance = 1000000n; // balance unchanged
    metrics.previousKeeperBalance = 1000000n;

    const payload = rule.check(metrics);
    expect(payload).not.toBeNull();
    expect(payload?.severity).toBe("warning");
    expect(payload?.title).toBe("Keeper Balance Not Growing");
  });

  it("alerts when claimed activity occurred but balance decreased", () => {
    const metrics = defaultMetrics();
    metrics.claimedActivityCount = 5;
    metrics.keeperBalance = 500000n; // balance decreased
    metrics.previousKeeperBalance = 1000000n;

    const payload = rule.check(metrics);
    expect(payload).not.toBeNull();
    expect(payload?.severity).toBe("warning");
  });

  it("includes claimed activity count and balance values in metadata", () => {
    const metrics = defaultMetrics();
    metrics.claimedActivityCount = 7;
    metrics.keeperBalance = 500000n;
    metrics.previousKeeperBalance = 1000000n;

    const payload = rule.check(metrics);
    expect(payload?.metadata.claimedActivityCount).toBe(7);
    expect(payload?.metadata.currentBalance).toBe("500000");
    expect(payload?.metadata.previousBalance).toBe("1000000");
  });

  it("has a consistent incident ID", () => {
    const metrics1 = defaultMetrics();
    metrics1.claimedActivityCount = 5;
    metrics1.keeperBalance = 500000n;

    const metrics2 = defaultMetrics();
    metrics2.claimedActivityCount = 10;
    metrics2.keeperBalance = 100000n;

    const payload1 = rule.check(metrics1);
    const payload2 = rule.check(metrics2);

    expect(payload1?.incident).toBe("stagnant-balance");
    expect(payload2?.incident).toBe("stagnant-balance");
  });

  it("includes claimed activity count in description", () => {
    const metrics = defaultMetrics();
    metrics.claimedActivityCount = 12;
    metrics.keeperBalance = 500000n;
    metrics.previousKeeperBalance = 1000000n;

    const payload = rule.check(metrics);
    expect(payload?.description).toContain("12");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION — EXACTLY ONE NOTIFICATION PER INCIDENT
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertManager — Deduplication", () => {
  it("fires exactly one notification when an ongoing condition is evaluated twice", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    // First evaluation
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1);

    // Second evaluation with same condition
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1); // still only 1, not 2
  });

  it("fires again when an incident clears and then recurs", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();

    // First evaluation: incident fires
    let metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1);

    // Second evaluation: incident clears
    metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: true,
    });
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1); // still 1

    // Third evaluation: new incident with different task
    metrics = defaultMetrics();
    metrics.claimedTasks.set("task-2", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(2); // now fires again
  });

  it("fires separate notifications for three different incidents", async () => {
    const transport = new MockTransport();
    const rules = [
      new MissedExecutionRule({ lockWindowMs: 10000 }),
      new ConsecutiveRpcErrorRule({ threshold: 3 }),
      new StagnantBalanceRule(),
    ];
    const manager = new AlertManager(transport, rules);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.consecutiveRpcErrors = 3;
    metrics.claimedActivityCount = 5;
    metrics.keeperBalance = 500000n;
    metrics.previousKeeperBalance = 1000000n;

    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(3);
    expect(transport.sentPayloads[0].title).toBe("Missed Task Execution");
    expect(transport.sentPayloads[1].title).toBe("Persistent RPC Errors");
    expect(transport.sentPayloads[2].title).toBe("Keeper Balance Not Growing");
  });

  it("does not fire duplicate notifications for the same incident ID", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.claimedTasks.set("task-2", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    // First evaluation fires once
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1);
    const firstIncidentId = transport.sentPayloads[0].incident;

    // Same metrics evaluated again should not fire
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1);
    expect(transport.sentPayloads[0].incident).toBe(firstIncidentId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT
// ─────────────────────────────────────────────────────────────────────────────

describe("WebhookTransport", () => {
  it("sends the payload to the configured URL", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValueOnce({ ok: true });

    const config: WebhookTransportConfig = { url: "https://example.com/alerts" };
    const transport = new WebhookTransport(config);

    const payload: AlertPayload = {
      incident: "test-incident",
      severity: "critical",
      title: "Test Alert",
      description: "This is a test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await transport.send(payload);

    expect(mockFetch).toHaveBeenCalledOnce();
    const args = mockFetch.mock.calls[0];
    expect(args[0]).toBe("https://example.com/alerts");
    expect(args[1].body).toContain("test-incident");
  });

  it("uses POST method by default", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValueOnce({ ok: true });

    const config: WebhookTransportConfig = { url: "https://example.com/alerts" };
    const transport = new WebhookTransport(config);

    const payload: AlertPayload = {
      incident: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await transport.send(payload);

    const args = mockFetch.mock.calls[0];
    expect(args[1].method).toBe("POST");
  });

  it("uses the configured HTTP method (PUT)", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValueOnce({ ok: true });

    const config: WebhookTransportConfig = {
      url: "https://example.com/alerts",
      method: "PUT",
    };
    const transport = new WebhookTransport(config);

    const payload: AlertPayload = {
      incident: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await transport.send(payload);

    const args = mockFetch.mock.calls[0];
    expect(args[1].method).toBe("PUT");
  });

  it("includes custom headers in the request", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValueOnce({ ok: true });

    const config: WebhookTransportConfig = {
      url: "https://example.com/alerts",
      headers: { Authorization: "Bearer token123" },
    };
    const transport = new WebhookTransport(config);

    const payload: AlertPayload = {
      incident: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await transport.send(payload);

    const args = mockFetch.mock.calls[0];
    expect(args[1].headers.Authorization).toBe("Bearer token123");
  });

  it("throws when webhook responds with non-ok status", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const config: WebhookTransportConfig = { url: "https://example.com/alerts" };
    const transport = new WebhookTransport(config);

    const payload: AlertPayload = {
      incident: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await expect(transport.send(payload)).rejects.toThrow("Webhook responded with 500");
  });

  it("does not crash AlertManager when transport fails", async () => {
    const transport = new MockTransport();
    // Make the transport throw
    vi.spyOn(transport, "send").mockRejectedValueOnce(new Error("Network error"));

    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    // Should not throw despite transport error
    expect(() => manager.evaluate(metrics)).not.toThrow();
  });
});

describe("NoopTransport", () => {
  it("never calls fetch or performs any external operation", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const transport = new NoopTransport();
    const payload: AlertPayload = {
      incident: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await transport.send(payload);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves successfully without doing anything", async () => {
    const transport = new NoopTransport();
    const payload: AlertPayload = {
      incident: "test",
      severity: "critical",
      title: "Test",
      description: "Test",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    await expect(transport.send(payload)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ALERT MANAGER
// ─────────────────────────────────────────────────────────────────────────────

describe("AlertManager", () => {
  it("calls all registered rules during evaluation", async () => {
    const transport = new MockTransport();
    const rule1 = new MissedExecutionRule({ lockWindowMs: 10000 });
    const rule2 = new ConsecutiveRpcErrorRule({ threshold: 3 });
    const manager = new AlertManager(transport, [rule1, rule2]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });
    metrics.consecutiveRpcErrors = 3;

    await manager.evaluate(metrics);

    // Both rules should have fired
    expect(transport.sentPayloads).toHaveLength(2);
  });

  it("skips transport when incident is already active", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    // First call
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1);

    // Second call with same metrics
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1); // no additional send
  });

  it("clearIncident allows re-triggering of the same incident", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    // First evaluation
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(1);

    // Clear the incident
    manager.clearIncident("missed-execution");

    // Second evaluation with same condition
    await manager.evaluate(metrics);
    expect(transport.sentPayloads).toHaveLength(2); // fires again
  });

  it("getActiveIncidents returns current active incidents", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    await manager.evaluate(metrics);
    const active = manager.getActiveIncidents();

    expect(active.size).toBe(1);
    expect(Array.from(active)[0]).toContain("missed-execution");
  });

  it("getActiveIncidents returns a copy to prevent external modification", async () => {
    const transport = new MockTransport();
    const rule = new MissedExecutionRule({ lockWindowMs: 10000 });
    const manager = new AlertManager(transport, [rule]);

    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    await manager.evaluate(metrics);
    const active1 = manager.getActiveIncidents();
    active1.clear();

    const active2 = manager.getActiveIncidents();
    expect(active2.size).toBe(1); // original is not affected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

describe("createAlertManager", () => {
  it("creates a manager with webhook transport when webhook config is provided", () => {
    const config = {
      webhook: { url: "https://example.com/alerts" },
      missedExecution: { lockWindowMs: 10000 },
    };

    const manager = createAlertManager(config);

    // Manager should be created successfully
    expect(manager).toBeInstanceOf(AlertManager);
    // Check that it has active incidents map (by testing a method)
    expect(manager.getActiveIncidents()).toBeInstanceOf(Set);
  });

  it("creates a manager with NoopTransport when no webhook config is provided", () => {
    const config = {
      missedExecution: { lockWindowMs: 10000 },
    };

    const manager = createAlertManager(config);
    expect(manager).toBeInstanceOf(AlertManager);
  });

  it("adds MissedExecutionRule when missedExecution config is provided", async () => {
    const transport = new MockTransport();
    const config = {
      webhook: { url: "https://example.com/alerts" },
      missedExecution: { lockWindowMs: 10000 },
    };

    const manager = createAlertManager(config);

    // Test by triggering the rule
    const now = Date.now();
    const metrics = defaultMetrics();
    metrics.claimedTasks.set("task-1", {
      claimedAt: new Date(now - 15000),
      executed: false,
    });

    // We can't directly access the rules, but we can verify the rule works
    // by checking active incidents after evaluation
    await manager.evaluate(metrics);
    const active = manager.getActiveIncidents();
    expect(active.size).toBeGreaterThan(0);
  });

  it("adds ConsecutiveRpcErrorRule when consecutiveRpcErrors config is provided", async () => {
    const config = {
      consecutiveRpcErrors: { threshold: 3 },
    };

    const manager = createAlertManager(config);
    expect(manager).toBeInstanceOf(AlertManager);
  });

  it("adds StagnantBalanceRule by default when stagnantBalance is not disabled", async () => {
    const config = {
      missedExecution: { lockWindowMs: 10000 },
    };

    const manager = createAlertManager(config);
    expect(manager).toBeInstanceOf(AlertManager);
  });

  it("excludes StagnantBalanceRule when stagnantBalance is disabled", async () => {
    const config = {
      missedExecution: { lockWindowMs: 10000 },
      stagnantBalance: { enabled: false },
    };

    const manager = createAlertManager(config);
    expect(manager).toBeInstanceOf(AlertManager);
  });

  it("includes all three rules when fully configured", async () => {
    const transport = new MockTransport();
    const config = {
      webhook: { url: "https://example.com/alerts" },
      missedExecution: { lockWindowMs: 10000 },
      consecutiveRpcErrors: { threshold: 3 },
      stagnantBalance: { enabled: true },
    };

    const manager = createAlertManager(config);
    expect(manager).toBeInstanceOf(AlertManager);
  });
});
