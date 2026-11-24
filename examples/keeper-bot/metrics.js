/**
 * Optional Prometheus metrics for the example keeper bot.
 *
 * This module deliberately uses only Node's standard library. The example is
 * meant to be readable by someone meeting Soroban for the first time, so the
 * metrics endpoint must not pull in Express, prom-client or any other package.
 *
 * Metric names match examples/keeper-bot-v2/src/metrics.ts wherever the
 * meaning is the same. The canonical catalogue is docs/OBSERVABILITY.md.
 */

"use strict";

const http = require("node:http");

/** Skip reasons are a fixed set so the `reason` label stays bounded. */
const SKIP_REASONS = new Set([
  "expired",
  "unsupported_verifier",
  "no_proof",
  "evaluation_error",
  "unprofitable",
  "lost_claim_race",
  "other",
]);

/** Error types are a fixed set so the `error_type` label stays bounded. */
const ERROR_TYPES = new Set([
  "timeout",
  "network",
  "rate_limit",
  "contract",
  "unknown",
]);

/** Escapes a value for use inside a quoted Prometheus label. */
function escapeLabel(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Maps an arbitrary error to a small, bounded label value.
 *
 * The raw message is never returned: RPC errors can embed provider URLs that
 * carry an API key, which would leak into the scrape endpoint. Unknown shapes
 * become "unknown" rather than the message itself.
 */
function classifyError(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (
    msg.includes("econn") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("429") ||
    msg.includes("rate limit")
  ) {
    return msg.includes("429") || msg.includes("rate limit")
      ? "rate_limit"
      : "network";
  }
  if (
    msg.includes("simulation failed") ||
    msg.includes("invalidaction") ||
    msg.includes("unauthorized") ||
    msg.includes("already")
  ) {
    return "contract";
  }
  return "unknown";
}

/** Coerces a caller-supplied label to the documented, bounded set. */
function bounded(value, allowed, fallback) {
  const normalised = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  return allowed.has(normalised) ? normalised : fallback;
}

class MetricsCollector {
  constructor() {
    this.roundsTotal = 0;
    this.evaluatedTotal = 0;
    this.claimedTotal = 0;
    this.executedTotal = 0;
    this.skippedByReason = Object.create(null);
    this.rpcErrorsByType = Object.create(null);
  }

  recordRound() {
    this.roundsTotal += 1;
  }

  recordEvaluation(count = 1) {
    this.evaluatedTotal += count;
  }

  recordClaim() {
    this.claimedTotal += 1;
  }

  recordExecution() {
    this.executedTotal += 1;
  }

  recordSkip(reason) {
    const key = bounded(reason, SKIP_REASONS, "other");
    this.skippedByReason[key] = (this.skippedByReason[key] || 0) + 1;
  }

  /**
   * Records an RPC error. Accepts an Error (classified here) or an already
   * classified type string; both end up in the bounded ERROR_TYPES set.
   */
  recordRpcError(err) {
    const key = typeof err === "string" ? bounded(err, ERROR_TYPES, "unknown") : classifyError(err);
    this.rpcErrorsByType[key] = (this.rpcErrorsByType[key] || 0) + 1;
  }

  /** Prometheus text exposition, version 0.0.4. */
  render() {
    const lines = [];
    const counter = (name, help, value) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    };
    const labelled = (name, help, label, values) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const key of Object.keys(values).sort()) {
        lines.push(`${name}{${label}="${escapeLabel(key)}"} ${values[key]}`);
      }
    };

    counter("soroban_keeper_rounds_total", "Polling rounds started.", this.roundsTotal);
    counter("soroban_keeper_tasks_evaluated_total", "Total candidate tasks evaluated.", this.evaluatedTotal);
    counter("soroban_keeper_tasks_claimed_total", "Total tasks claimed by the keeper.", this.claimedTotal);
    counter("soroban_keeper_tasks_executed_total", "Total tasks successfully executed.", this.executedTotal);
    labelled(
      "soroban_keeper_tasks_skipped_total",
      "Total tasks skipped.",
      "reason",
      this.skippedByReason
    );
    labelled(
      "soroban_keeper_rpc_errors_total",
      "Count of RPC errors encountered by type.",
      "error_type",
      this.rpcErrorsByType
    );
    return `${lines.join("\n")}\n`;
  }
}

/**
 * Starts the metrics endpoint on loopback only.
 *
 * Binding to 127.0.0.1 means the endpoint is not reachable from another host
 * without an explicit reverse proxy or tunnel. See docs/OBSERVABILITY.md.
 */
function startMetricsServer(collector, port, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
      res.end(collector.render());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });
  server.listen(port, host);
  return server;
}

module.exports = {
  MetricsCollector,
  classifyError,
  escapeLabel,
  startMetricsServer,
  SKIP_REASONS,
  ERROR_TYPES,
};
