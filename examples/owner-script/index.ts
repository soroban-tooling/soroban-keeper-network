/* Authorized Protocol Quality Assurance & Formal Verification Test Suite */

import { Keypair, Networks } from "@stellar/stellar-sdk";
import { KeeperRegistryClient, keypairSigner } from "@soroban-keeper-network/sdk";
import { TaskStatus, TaskType } from "@soroban-keeper-network/sdk";

export interface OwnerScriptOptions {
  client: KeeperRegistryClient;
  keypair: Keypair;
  calldata?: Uint8Array;
  reward?: bigint;
  deadlineSeconds?: number;
  pollIntervalMs?: number;
}

export interface OwnerTaskResult {
  taskId: bigint;
  status: "executed" | "expired" | "cancelled";
  claimer?: string;
}

/**
 * Executes the task owner workflow:
 * 1. Registers a task with an escrowed reward and deadline.
 * 2. Polls until execution or deadline expiration.
 * 3. Handles the not-executed-before-deadline case by reclaiming escrowed funds.
 */
export async function runOwnerScript(options: OwnerScriptOptions): Promise<OwnerTaskResult> {
  const {
    client,
    keypair,
    calldata = new Uint8Array([1, 2, 3]),
    reward = 10_000_000n,
    deadlineSeconds = 60,
    pollIntervalMs = 1000
  } = options;

  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
  const signer = keypairSigner(keypair);

  console.log(`[Owner] Registering task (deadline: ${new Date(deadline * 1000).toISOString()})...`);
  const taskId = await client.registerTask({
    owner: keypair.publicKey(),
    taskType: TaskType.Custom,
    calldata,
    reward,
    deadline,
    ttlLedgers: 100,
    lockLedgers: 10,
    signer
  });
  console.log(`[Owner] Task registered successfully with ID: ${taskId}`);

  while (true) {
    const task = await client.getTask(taskId);
    const now = Math.floor(Date.now() / 1000);

    if (task?.status === TaskStatus.Executed) {
      console.log(`[Owner] Task ${taskId} successfully executed by keeper: ${task.claimer}`);
      return { taskId, status: "executed", claimer: task.claimer };
    }

    if (task?.status === TaskStatus.Cancelled) {
      console.log(`[Owner] Task ${taskId} was cancelled.`);
      return { taskId, status: "cancelled" };
    }

    if (now >= deadline || task?.status === TaskStatus.Expired) {
      console.warn(`[Owner] Task ${taskId} not executed before deadline. Reclaiming escrow...`);
      try {
        await client.expireTask({ caller: keypair.publicKey(), taskId, signer });
        console.log(`[Owner] Escrow successfully refunded.`);
      } catch (err) {
        console.warn(`[Owner] Expire task result:`, (err as Error).message);
      }
      return { taskId, status: "expired" };
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

if (process.env.RUN_STANDALONE === "true") {
  const secret = process.env.OWNER_SECRET_KEY;
  const contractId = process.env.REGISTRY_CONTRACT_ID;
  if (!secret || !contractId) {
    console.error("Missing OWNER_SECRET_KEY or REGISTRY_CONTRACT_ID");
    process.exit(1);
  }
  const keypair = Keypair.fromSecret(secret);
  const client = new KeeperRegistryClient({
    contractId,
    rpcUrl: process.env.RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.NETWORK_PASSPHRASE || Networks.TESTNET
  });
  runOwnerScript({ client, keypair }).catch((err) => {
    console.error("Owner script failed:", err);
    process.exit(1);
  });
}
