import { describe, expect, it } from "vitest";

import {
  LogEventType,
  consoleLogger,
  logError,
  logInfo,
  logOperationOutcome,
  logProfitabilityEvaluation,
  logSimulationFailed,
  logSimulationStarted,
  logSimulationSucceeded,
  noOpLogger,
  type LogEvent,
} from "../src/logging.js";

describe("LogEventType", () => {
  it("defines all required event types", () => {
    expect(LogEventType.Simulation).toBe("simulation");
    expect(LogEventType.Profitability).toBe("profitability");
    expect(LogEventType.Outcome).toBe("outcome");
    expect(LogEventType.Error).toBe("error");
    expect(LogEventType.Info).toBe("info");
  });
});

describe("noOpLogger", () => {
  it("accepts all event types without side effects", () => {
    const event: LogEvent = {
      type: LogEventType.Simulation,
      operation: "claim_task",
      status: "started",
    };

    expect(() => noOpLogger(event)).not.toThrow();
  });
});

describe("consoleLogger", () => {
  it("logs simulation started events", () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      const event = logSimulationStarted("claim_task", 42n);
      consoleLogger(event);

      expect(logs).toHaveLength(1);
      const msg = (logs[0] as unknown[])[0] as string;
      expect(msg).toContain("[SIMULATION]");
      expect(msg).toContain("claim_task");
      expect(msg).toContain("started");
      expect(msg).toContain("task 42");
    } finally {
      console.log = originalLog;
    }
  });

  it("logs simulation succeeded events with duration", () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      const event = logSimulationSucceeded("execute_task", 150, 43n);
      consoleLogger(event);

      expect(logs).toHaveLength(1);
      const msg = (logs[0] as unknown[])[0] as string;
      expect(msg).toContain("[SIMULATION]");
      expect(msg).toContain("succeeded");
      expect(msg).toContain("150ms");
    } finally {
      console.log = originalLog;
    }
  });

  it("logs simulation failed events with error code", () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      const event = logSimulationFailed(
        "execute_task",
        5, // InvalidTaskStatus
        "Task is not in Claimed status",
        44n,
        120,
      );
      consoleLogger(event);

      expect(logs).toHaveLength(1);
      const msg = (logs[0] as unknown[])[0] as string;
      expect(msg).toContain("[SIMULATION]");
      expect(msg).toContain("failed");
      expect(msg).toContain("Task is not in Claimed status");
    } finally {
      console.log = originalLog;
    }
  });

  it("logs profitability evaluation decisions", () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      const event = logProfitabilityEvaluation(
        45n,
        "unprofitable",
        1_000_000n,
        1_700_000n,
        -700_000n,
        0n,
        "negative profit",
      );
      consoleLogger(event);

      expect(logs).toHaveLength(1);
      const msg = (logs[0] as unknown[])[0] as string;
      expect(msg).toContain("[PROFITABILITY]");
      expect(msg).toContain("Task 45");
      expect(msg).toContain("unprofitable");
      expect(msg).toContain("negative profit");
    } finally {
      console.log = originalLog;
    }
  });

  it("logs operation outcomes", () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      const event = logOperationOutcome(
        "execute_task",
        "invalid_task_status",
        "Task moved out of Claimed status",
        46n,
      );
      consoleLogger(event);

      expect(logs).toHaveLength(1);
      const msg = (logs[0] as unknown[])[0] as string;
      expect(msg).toContain("[OUTCOME]");
      expect(msg).toContain("execute_task");
      expect(msg).toContain("invalid_task_status");
    } finally {
      console.log = originalLog;
    }
  });

  it("logs errors to console.error", () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);

    try {
      const event = logError(
        "Simulation failed unexpectedly",
        "claim_task",
        47n,
        2, // Unauthorized
      );
      consoleLogger(event);

      expect(errors).toHaveLength(1);
      const msg = (errors[0] as unknown[])[0] as string;
      expect(msg).toContain("[ERROR]");
      expect(msg).toContain("Simulation failed unexpectedly");
    } finally {
      console.error = originalError;
    }
  });

  it("logs info events", () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      const event = logInfo("Keeper started", { round: 1, tasks: 5 });
      consoleLogger(event);

      expect(logs).toHaveLength(1);
      const msg = (logs[0] as unknown[])[0] as string;
      expect(msg).toContain("[INFO]");
      expect(msg).toContain("Keeper started");
    } finally {
      console.log = originalLog;
    }
  });

  it("includes stack traces for errors when provided", () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);

    try {
      const stack = "Error: Something went wrong\n  at line 42";
      const event = logError("Unexpected error", undefined, undefined, undefined, stack);
      consoleLogger(event);

      expect(errors).toHaveLength(2); // Message and stack
    } finally {
      console.error = originalError;
    }
  });
});

describe("log event helper functions", () => {
  describe("logSimulationStarted", () => {
    it("creates a simulation started event", () => {
      const event = logSimulationStarted("claim_task");

      expect(event.type).toBe(LogEventType.Simulation);
      expect(event.operation).toBe("claim_task");
      expect(event.status).toBe("started");
      expect(event.taskId).toBeUndefined();
    });

    it("includes optional taskId", () => {
      const event = logSimulationStarted("execute_task", 50n);

      expect(event.taskId).toBe(50n);
    });
  });

  describe("logSimulationSucceeded", () => {
    it("creates a simulation succeeded event with duration", () => {
      const event = logSimulationSucceeded("claim_task", 100);

      expect(event.type).toBe(LogEventType.Simulation);
      expect(event.operation).toBe("claim_task");
      expect(event.status).toBe("succeeded");
      expect(event.durationMs).toBe(100);
    });

    it("includes message if provided", () => {
      const event = logSimulationSucceeded("claim_task", 100, 51n, "Task is claimable");

      expect(event.message).toBe("Task is claimable");
    });
  });

  describe("logSimulationFailed", () => {
    it("creates a simulation failed event with error code", () => {
      const event = logSimulationFailed("execute_task", 5, "Invalid task status");

      expect(event.type).toBe(LogEventType.Simulation);
      expect(event.operation).toBe("execute_task");
      expect(event.status).toBe("failed");
      expect(event.errorCode).toBe(5);
      expect(event.message).toBe("Invalid task status");
    });

    it("includes duration if provided", () => {
      const event = logSimulationFailed("execute_task", 5, "Error", 52n, 200);

      expect(event.durationMs).toBe(200);
    });
  });

  describe("logProfitabilityEvaluation", () => {
    it("creates a profitability event", () => {
      const event = logProfitabilityEvaluation(
        53n,
        "profitable",
        2_000_000n,
        1_700_000n,
        300_000n,
        0n,
      );

      expect(event.type).toBe(LogEventType.Profitability);
      expect(event.taskId).toBe(53n);
      expect(event.decision).toBe("profitable");
      expect(event.reward).toBe(2_000_000n);
      expect(event.totalFees).toBe(1_700_000n);
      expect(event.netProfit).toBe(300_000n);
    });

    it("includes reason if unprofitable", () => {
      const event = logProfitabilityEvaluation(
        54n,
        "unprofitable",
        1_000_000n,
        1_700_000n,
        -700_000n,
        0n,
        "negative profit",
      );

      expect(event.reason).toBe("negative profit");
    });
  });

  describe("logOperationOutcome", () => {
    it("creates an operation outcome event", () => {
      const event = logOperationOutcome(
        "claim_task",
        "claimed",
        "Task claimed successfully",
        55n,
      );

      expect(event.type).toBe(LogEventType.Outcome);
      expect(event.operation).toBe("claim_task");
      expect(event.status).toBe("claimed");
      expect(event.message).toBe("Task claimed successfully");
      expect(event.taskId).toBe(55n);
    });

    it("includes amount for withdraw_rewards", () => {
      const event = logOperationOutcome(
        "withdraw_rewards",
        "withdrawn",
        undefined,
        undefined,
        500_000n,
      );

      expect(event.amount).toBe(500_000n);
    });
  });

  describe("logError", () => {
    it("creates an error event with message", () => {
      const event = logError("Network error");

      expect(event.type).toBe(LogEventType.Error);
      expect(event.message).toBe("Network error");
    });

    it("includes operation context", () => {
      const event = logError("RPC timeout", "claim_task", 56n);

      expect(event.operation).toBe("claim_task");
      expect(event.taskId).toBe(56n);
    });

    it("includes error code and stack trace", () => {
      const stack = "Error at...\n";
      const event = logError("Auth failed", undefined, undefined, 2, stack);

      expect(event.errorCode).toBe(2);
      expect(event.stack).toBe(stack);
    });
  });

  describe("logInfo", () => {
    it("creates an info event with message", () => {
      const event = logInfo("Keeper started");

      expect(event.type).toBe(LogEventType.Info);
      expect(event.message).toBe("Keeper started");
    });

    it("includes optional metadata", () => {
      const event = logInfo("Keeper started", { round: 1, network: "testnet" });

      expect(event.round).toBe(1);
      expect(event.network).toBe("testnet");
    });
  });
});

describe("event type discrimination", () => {
  it("events can be filtered by type", () => {
    const events: LogEvent[] = [
      logSimulationStarted("claim_task"),
      logProfitabilityEvaluation(1n, "profitable", 2_000_000n, 1_700_000n, 300_000n, 0n),
      logOperationOutcome("claim_task", "claimed"),
      logError("Something went wrong"),
      logInfo("Keeper running"),
    ];

    const simulations = events.filter((e) => e.type === LogEventType.Simulation);
    const profitability = events.filter((e) => e.type === LogEventType.Profitability);
    const outcomes = events.filter((e) => e.type === LogEventType.Outcome);
    const errors = events.filter((e) => e.type === LogEventType.Error);
    const info = events.filter((e) => e.type === LogEventType.Info);

    expect(simulations).toHaveLength(1);
    expect(profitability).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(info).toHaveLength(1);
  });
});
