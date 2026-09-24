/**
 * Logging utilities for keeper-bot-v2.
 *
 * Provides structured, categorized logging for all major bot decisions,
 * especially skip reasons, which must be logged distinctly from errors
 * (issue #0254 acceptance criterion: "Skipped-for-profitability is logged
 * distinctly from skipped-for-other-reasons, so an operator can tell whether
 * the bot is idle for lack of tasks or for lack of profitable ones").
 *
 * **Design**: All log events are categorized by type (simulation, profitability,
 * outcome, error) so they can be filtered and analyzed separately. This enables
 * operators to:
 *
 * - Monitor simulation success/failure rates.
 * - Identify which tasks are profitable vs. unprofitable.
 * - Distinguish routine skips from actual errors requiring intervention.
 * - Correlate simulation overhead with task completion time.
 */

/**
 * Event category for structured logging.
 */
export enum LogEventType {
  /** Simulation started or result available. */
  Simulation = "simulation",

  /** Profitability evaluation result. */
  Profitability = "profitability",

  /** Operation outcome (claim, execute, withdraw). */
  Outcome = "outcome",

  /** Error or failure. */
  Error = "error",

  /** General info (startup, shutdown, etc.). */
  Info = "info",
}

/**
 * Structured log event for simulation activities.
 */
export interface SimulationLogEvent {
  type: LogEventType.Simulation;
  /** The operation being simulated (claim_task, execute_task, withdraw_rewards, is_claimable, keeper_balance, etc.). */
  operation: string;
  /** Task ID, if applicable. */
  taskId?: bigint | number;
  /** "started" | "succeeded" | "failed". */
  status: "started" | "succeeded" | "failed";
  /** Time in ms for the simulation to complete. */
  durationMs?: number;
  /** Error code if failed, from KeeperErrorCode. */
  errorCode?: number;
  /** Human-readable error or outcome. */
  message?: string;
}

/**
 * Structured log event for profitability decisions.
 */
export interface ProfitabilityLogEvent {
  type: LogEventType.Profitability;
  taskId: bigint | number;
  /** "profitable" | "unprofitable". */
  decision: "profitable" | "unprofitable";
  reward: bigint;
  totalFees: bigint;
  netProfit: bigint;
  minMargin: bigint;
  reason?: string;
}

/**
 * Structured log event for operation outcomes.
 */
export interface OperationOutcomeLogEvent {
  type: LogEventType.Outcome;
  /** The operation completed (claim_task, execute_task, withdraw_rewards). */
  operation: string;
  taskId?: bigint | number;
  /** The outcome status from the operation's outcome type. */
  status: string;
  /** Message explaining the outcome. */
  message?: string;
  /** Amount moved (for withdraw_rewards) or other numeric result. */
  amount?: bigint;
}

/**
 * Structured log event for errors.
 */
export interface ErrorLogEvent {
  type: LogEventType.Error;
  /** The operation that errored. */
  operation?: string;
  taskId?: bigint | number;
  /** Error code if available. */
  errorCode?: number;
  /** Human-readable error message. */
  message: string;
  /** Stack trace if available. */
  stack?: string;
}

/**
 * Structured log event for general info.
 */
export interface InfoLogEvent {
  type: LogEventType.Info;
  message: string;
  [key: string]: unknown;
}

/** Union of all log event types. */
export type LogEvent =
  | SimulationLogEvent
  | ProfitabilityLogEvent
  | OperationOutcomeLogEvent
  | ErrorLogEvent
  | InfoLogEvent;

/**
 * A logger function that accepts structured log events.
 *
 * Bots can implement this to send events to their preferred logging backend
 * (console, file, syslog, Datadog, CloudWatch, etc.).
 *
 * @example
 * ```ts
 * const logger: Logger = (event) => {
 *   const timestamp = new Date().toISOString();
 *   const level = event.type === LogEventType.Error ? "ERROR" : "INFO";
 *   console.log(`[${timestamp}] [${level}] [${event.type}]`, JSON.stringify(event));
 * };
 * ```
 */
export type Logger = (event: LogEvent) => void;

/**
 * A no-op logger that discards all events.
 *
 * Useful for tests or when logging is disabled.
 */
export const noOpLogger: Logger = () => {
  // no-op
};

/**
 * A console logger that pretty-prints events to stdout/stderr.
 *
 * Uses:
 * - `console.log` for Simulation, Profitability, Outcome, Info events.
 * - `console.error` for Error events.
 *
 * @example
 * ```ts
 * const bot = new KeeperBot({ ..., logger: consoleLogger });
 * ```
 */
export const consoleLogger: Logger = (event) => {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case LogEventType.Simulation:
      console.log(
        `[${timestamp}] [SIMULATION] ${event.operation} ` +
          (event.taskId ? `(task ${event.taskId}) ` : "") +
          `${event.status}` +
          (event.durationMs ? ` (${event.durationMs}ms)` : "") +
          (event.message ? `: ${event.message}` : ""),
      );
      break;

    case LogEventType.Profitability:
      console.log(
        `[${timestamp}] [PROFITABILITY] Task ${event.taskId}: ${event.decision} ` +
          `(reward: ${event.reward}, fees: ${event.totalFees}, net: ${event.netProfit})` +
          (event.reason ? ` — ${event.reason}` : ""),
      );
      break;

    case LogEventType.Outcome:
      console.log(
        `[${timestamp}] [OUTCOME] ${event.operation} ` +
          (event.taskId ? `(task ${event.taskId}) ` : "") +
          `${event.status}` +
          (event.amount ? ` (${event.amount} stroops)` : "") +
          (event.message ? `: ${event.message}` : ""),
      );
      break;

    case LogEventType.Error:
      console.error(
        `[${timestamp}] [ERROR] ` +
          (event.operation ? `${event.operation} ` : "") +
          (event.taskId ? `(task ${event.taskId}) ` : "") +
          event.message,
      );
      if (event.stack) {
        console.error(event.stack);
      }
      break;

    case LogEventType.Info:
      console.log(`[${timestamp}] [INFO] ${event.message}`);
      break;

    default:
      // Satisfy TypeScript exhaustiveness check
      const _exhaustive: never = event;
      return _exhaustive;
  }
};

/**
 * Helper to create a simulation log event for "started" status.
 */
export function logSimulationStarted(
  operation: string,
  taskId?: bigint | number,
): SimulationLogEvent {
  return {
    type: LogEventType.Simulation,
    operation,
    taskId,
    status: "started",
  };
}

/**
 * Helper to create a simulation log event for "succeeded" status.
 */
export function logSimulationSucceeded(
  operation: string,
  durationMs: number,
  taskId?: bigint | number,
  message?: string,
): SimulationLogEvent {
  return {
    type: LogEventType.Simulation,
    operation,
    taskId,
    status: "succeeded",
    durationMs,
    message,
  };
}

/**
 * Helper to create a simulation log event for "failed" status.
 */
export function logSimulationFailed(
  operation: string,
  errorCode: number,
  message: string,
  taskId?: bigint | number,
  durationMs?: number,
): SimulationLogEvent {
  return {
    type: LogEventType.Simulation,
    operation,
    taskId,
    status: "failed",
    durationMs,
    errorCode,
    message,
  };
}

/**
 * Helper to create a profitability log event.
 */
export function logProfitabilityEvaluation(
  taskId: bigint | number,
  decision: "profitable" | "unprofitable",
  reward: bigint,
  totalFees: bigint,
  netProfit: bigint,
  minMargin: bigint,
  reason?: string,
): ProfitabilityLogEvent {
  return {
    type: LogEventType.Profitability,
    taskId,
    decision,
    reward,
    totalFees,
    netProfit,
    minMargin,
    reason,
  };
}

/**
 * Helper to create an operation outcome log event.
 */
export function logOperationOutcome(
  operation: string,
  status: string,
  message?: string,
  taskId?: bigint | number,
  amount?: bigint,
): OperationOutcomeLogEvent {
  return {
    type: LogEventType.Outcome,
    operation,
    taskId,
    status,
    message,
    amount,
  };
}

/**
 * Helper to create an error log event.
 */
export function logError(
  message: string,
  operation?: string,
  taskId?: bigint | number,
  errorCode?: number,
  stack?: string,
): ErrorLogEvent {
  return {
    type: LogEventType.Error,
    message,
    operation,
    taskId,
    errorCode,
    stack,
  };
}

/**
 * Helper to create an info log event.
 */
export function logInfo(message: string, data?: Record<string, unknown>): InfoLogEvent {
  return {
    type: LogEventType.Info,
    message,
    ...data,
  };
}
