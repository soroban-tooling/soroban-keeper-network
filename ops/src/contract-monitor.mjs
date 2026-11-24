/**
 * Read-only contract state monitor (issue #726).
 *
 * Polls only view entry points and ledger TTL. It never constructs a signer,
 * so it can run with no funded key and no signing material in its environment.
 */

import http from "node:http";
import { feesAccrued, isPaused, taskCount, version } from "@soroban-keeper-network/sdk";
import { instanceTtlRemainingSeconds } from "./rpc.mjs";
import { renderPrometheus } from "./metrics.mjs";

export async function collectContractSamples({
  client,
  server,
  contractId,
  readInstanceTtl = instanceTtlRemainingSeconds,
}) {
  const [paused, fees, count, contractVersion, ttlSeconds] = await Promise.all([
    isPaused(client),
    feesAccrued(client),
    taskCount(client),
    version(client, { warnOnMismatch: false }),
    readInstanceTtl(server, contractId),
  ]);

  const labels = { contract_id: contractId };
  return [
    { name: "soroban_contract_paused", labels, value: paused ? 1 : 0 },
    { name: "soroban_contract_fees_accrued_stroops", labels, value: fees.toString() },
    { name: "soroban_contract_task_count", labels, value: count },
    { name: "soroban_contract_version", labels, value: contractVersion },
    { name: "soroban_contract_instance_ttl_remaining_seconds", labels, value: ttlSeconds },
  ];
}

/**
 * Creates a poll loop with injectable scheduling and error reporting.
 * A failed poll keeps the last good sample set and never throws out of the
 * timer, so one RPC hiccup cannot kill the monitor process.
 */
export function createContractMonitor({
  client,
  server,
  contractId,
  readInstanceTtl = instanceTtlRemainingSeconds,
  intervalMs = 60_000,
  scheduler = globalThis,
  onSamples = () => {},
  onError = () => {},
}) {
  let samples = [];
  let timer = undefined;
  let stopped = false;

  async function poll() {
    try {
      const fresh = await collectContractSamples({ client, server, contractId, readInstanceTtl });
      samples = fresh;
      onSamples(fresh);
      return fresh;
    } catch (error) {
      onError(error);
      return undefined;
    }
  }

  return {
    poll,
    getSamples: () => samples,
    render: () => renderPrometheus(samples),
    start() {
      stopped = false;
      timer = scheduler.setInterval(() => {
        void poll();
      }, intervalMs);
      return poll();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) scheduler.clearInterval(timer);
      timer = undefined;
    },
    isRunning: () => !stopped && timer !== undefined,
  };
}

/** Small Prometheus exposition endpoint for the monitor. */
export function startMonitorServer(supplySamples, port = 9091) {
  const server = http.createServer((request, response) => {
    if (request.url === "/metrics" || request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(renderPrometheus(supplySamples()));
    } else {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not Found");
    }
  });
  server.listen(port);
  return server;
}
