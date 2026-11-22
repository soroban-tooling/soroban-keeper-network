/**
 * Testnet canary entrypoint. Registration needs a funded key; nothing else
 * in the ops package does.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { keypairSigner } from "@soroban-keeper-network/sdk";
import { buildRegistryClient, buildRpcServer } from "../src/rpc.mjs";
import { createCanary } from "../src/canary.mjs";
import { startMonitorServer } from "../src/contract-monitor.mjs";

const secret = process.env.CANARY_SECRET_KEY;
const contractId = process.env.REGISTRY_CONTRACT_ID;
if (!secret || !contractId) {
  console.error("CANARY_SECRET_KEY and REGISTRY_CONTRACT_ID are required");
  process.exit(1);
}

const keypair = Keypair.fromSecret(secret);
const rpcServer = buildRpcServer({
  network: process.env.NETWORK,
  rpcUrl: process.env.RPC_URL,
});
const client = buildRegistryClient({
  contractId,
  network: process.env.NETWORK,
  rpcUrl: process.env.RPC_URL,
  server: rpcServer,
  signer: keypairSigner(keypair),
});

const port = Number(process.env.METRICS_PORT ?? 9092);
const canary = createCanary({
  client,
  owner: keypair.publicKey(),
  taskIdLabel: process.env.CANARY_TASK_ID ?? "testnet-canary",
  targetMs: Number(process.env.CANARY_TARGET_MS ?? 60_000),
  intervalMs: Number(process.env.CANARY_INTERVAL_MS ?? 600_000),
  reward: BigInt(process.env.CANARY_REWARD ?? "1"),
  onError: (error) => console.error("[canary] round failed:", error.message),
});
const server = startMonitorServer(canary.getSamples, port);

console.log(`[canary] owner ${keypair.publicKey()}, metrics on :${port}/metrics`);
void canary.start();

const shutdown = () => {
  canary.stop();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
