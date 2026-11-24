/**
 * Contract state monitor entrypoint. Reads views only; no signing key is read.
 */

import { buildRegistryClient, buildRpcServer } from "../src/rpc.mjs";
import { createContractMonitor, startMonitorServer } from "../src/contract-monitor.mjs";

const contractId = process.env.REGISTRY_CONTRACT_ID;
if (!contractId) {
  console.error("REGISTRY_CONTRACT_ID is required");
  process.exit(1);
}

const rpcServer = buildRpcServer({
  network: process.env.NETWORK,
  rpcUrl: process.env.RPC_URL,
});
const client = buildRegistryClient({
  contractId,
  network: process.env.NETWORK,
  rpcUrl: process.env.RPC_URL,
  server: rpcServer,
});

const port = Number(process.env.METRICS_PORT ?? 9091);
const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

const monitor = createContractMonitor({
  client,
  server: rpcServer,
  contractId,
  intervalMs,
  onError: (error) => console.error("[contract-monitor] poll failed:", error.message),
});
const server = startMonitorServer(monitor.getSamples, port);

console.log(`[contract-monitor] registry ${contractId}, metrics on :${port}/metrics`);
void monitor.start();

const shutdown = () => {
  monitor.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
