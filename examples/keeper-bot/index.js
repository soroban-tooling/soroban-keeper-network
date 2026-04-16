/**
 * Soroban Keeper Network — Example Keeper Bot
 *
 * This off-chain bot:
 *   1. Polls the Soroban RPC for TaskRegistered / TaskClaimed events emitted
 *      by the KeeperRegistry contract.
 *   2. For each Pending task whose deadline has not passed:
 *      a. Calls `claim_task` to lock the task.
 *      b. Executes the underlying operation off-chain (simulated here).
 *      c. Calls `execute_task` with a proof to claim the reward.
 *   3. Periodically calls `withdraw_rewards` to pull accumulated XLM.
 *
 * Usage:
 *   cp .env.example .env
 *   # Fill in your secret key and contract address
 *   node index.js
 *
 * Production keepers should add:
 *   - Persistent task state DB (SQLite / Redis) to avoid double-claiming
 *   - MEV-aware submission (bundle multiple tasks)
 *   - Retry logic with exponential back-off
 *   - Prometheus metrics endpoint
 *   - Alerting (PagerDuty / Telegram) on missed executions
 */

"use strict";

require("dotenv").config();

const {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Contract,
  Address,
} = require("@stellar/stellar-sdk");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — set via environment variables or .env file
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  network: process.env.NETWORK || "testnet",
  secretKey: process.env.KEEPER_SECRET_KEY || "",
  registryContractId: process.env.REGISTRY_CONTRACT_ID || "",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000", 10),
  withdrawThreshold: BigInt(process.env.WITHDRAW_THRESHOLD || "10000000"), // 1 XLM in stroops
  maxTasksPerRound: parseInt(process.env.MAX_TASKS_PER_ROUND || "5", 10),
};

const NETWORK_CONFIG = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  futurenet: {
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
  },
  mainnet: {
    rpcUrl: "https://mainnet.sorobanrpc.com",
    networkPassphrase: Networks.PUBLIC,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Validate configuration
// ─────────────────────────────────────────────────────────────────────────────

function validateConfig() {
  if (!CONFIG.secretKey) {
    console.error("❌  KEEPER_SECRET_KEY not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  if (!CONFIG.registryContractId) {
    console.error("❌  REGISTRY_CONTRACT_ID not set.");
    process.exit(1);
  }
  if (!NETWORK_CONFIG[CONFIG.network]) {
    console.error(`❌  Unknown NETWORK '${CONFIG.network}'. Use testnet, futurenet, or mainnet.`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Soroban helpers
// ─────────────────────────────────────────────────────────────────────────────

async function simulateAndSend(server, keypair, networkPassphrase, tx) {
  const simResponse = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResponse)) {
    throw new Error(`Simulation failed: ${simResponse.error}`);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResponse).build();
  preparedTx.sign(keypair);

  const sendResponse = await server.sendTransaction(preparedTx);
  if (sendResponse.status === "ERROR") {
    throw new Error(`Send failed: ${JSON.stringify(sendResponse.errorResult)}`);
  }

  // Poll for confirmation
  let getResponse = await server.getTransaction(sendResponse.hash);
  let attempts = 0;
  while (getResponse.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && attempts < 30) {
    await sleep(2000);
    getResponse = await server.getTransaction(sendResponse.hash);
    attempts++;
  }

  if (getResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    return getResponse;
  } else {
    throw new Error(`Transaction failed with status: ${getResponse.status}`);
  }
}

async function invokeContract(server, keypair, networkPassphrase, contractId, method, args) {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  return simulateAndSend(server, keypair, networkPassphrase, tx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Task fetching — reads pending tasks by querying events
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPendingTasks(server, contractId, startLedger) {
  const tasks = [];
  try {
    // Query TaskRegistered events (topic: ["reg", "task"])
    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
          topics: [
            ["AAAADwAAAANyZWc=", "AAAADwAAAAR0YXNr"], // "reg", "task" as base64 XDR
          ],
        },
      ],
      limit: 100,
    });

    for (const event of response.events || []) {
      try {
        const [taskIdVal, , rewardVal, deadlineVal] = event.value.value();
        const taskId = scValToNative(taskIdVal);
        const reward = scValToNative(rewardVal);
        const deadline = scValToNative(deadlineVal);

        tasks.push({ taskId, reward, deadline });
      } catch (e) {
        // Skip malformed events
      }
    }
  } catch (e) {
    console.warn("⚠️  Failed to fetch events:", e.message);
  }
  return tasks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keeper logic — off-chain execution simulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulates off-chain execution of the task (liquidation, oracle push, etc.)
 * In a real keeper this would:
 *   - Call the target protocol contract
 *   - Verify the action succeeded
 *   - Return the tx hash or state proof
 */
async function executeTaskOffChain(task) {
  console.log(`  ⚙️  Executing task ${task.taskId} off-chain...`);
  // Simulate network latency
  await sleep(500);

  // Return a fake "proof" — in production this is the target tx hash
  const fakeTxHash = Buffer.from(
    `keeper-proof:task:${task.taskId}:ts:${Date.now()}`
  ).toString("hex");
  return fakeTxHash;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main keeper loop
// ─────────────────────────────────────────────────────────────────────────────

async function keeperLoop(server, keypair, networkPassphrase, contractId) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  console.log(`\n🔄  Keeper round at ${new Date().toISOString()}`);

  // Determine start ledger for event query (last ~1000 ledgers ≈ 1.4h at 5s)
  const latestLedger = await server.getLatestLedger();
  const startLedger = Math.max(1, latestLedger.sequence - 1000);

  const pendingTasks = await fetchPendingTasks(server, contractId, startLedger);
  console.log(`  📋  Found ${pendingTasks.length} TaskRegistered events to evaluate`);

  let processed = 0;
  for (const task of pendingTasks) {
    if (processed >= CONFIG.maxTasksPerRound) break;

    // Skip tasks past their deadline
    if (task.deadline <= nowSeconds) {
      console.log(`  ⏰  Task ${task.taskId} is past deadline, skipping`);
      continue;
    }

    try {
      console.log(`  📌  Attempting to claim task ${task.taskId} (reward: ${task.reward})...`);

      // 1. Claim the task
      await invokeContract(server, keypair, networkPassphrase, contractId, "claim_task", [
        nativeToScVal(keypair.publicKey(), { type: "address" }),
        nativeToScVal(task.taskId, { type: "u64" }),
      ]);
      console.log(`  ✅  Task ${task.taskId} claimed!`);

      // 2. Execute off-chain
      const proof = await executeTaskOffChain(task);

      // 3. Submit execution proof on-chain
      await invokeContract(server, keypair, networkPassphrase, contractId, "execute_task", [
        nativeToScVal(keypair.publicKey(), { type: "address" }),
        nativeToScVal(task.taskId, { type: "u64" }),
        nativeToScVal(Buffer.from(proof, "hex"), { type: "bytes" }),
      ]);
      console.log(`  💰  Task ${task.taskId} executed! Proof: ${proof.slice(0, 20)}...`);
      processed++;
    } catch (err) {
      // Common reasons: already claimed by another keeper, or status mismatch
      console.warn(`  ⚠️  Failed to process task ${task.taskId}: ${err.message}`);
    }
  }

  // Check accumulated rewards and withdraw if above threshold
  try {
    const balanceResult = await invokeContract(
      server, keypair, networkPassphrase, contractId, "keeper_balance",
      [nativeToScVal(keypair.publicKey(), { type: "address" })]
    );
    if (balanceResult.returnValue) {
      const balance = BigInt(scValToNative(balanceResult.returnValue) || 0);
      console.log(`  💎  Accumulated reward balance: ${balance} stroops`);

      if (balance >= CONFIG.withdrawThreshold) {
        console.log(`  💸  Withdrawing ${balance} stroops...`);
        await invokeContract(server, keypair, networkPassphrase, contractId, "withdraw_rewards", [
          nativeToScVal(keypair.publicKey(), { type: "address" }),
        ]);
        console.log(`  ✅  Withdrawal complete!`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠️  Balance check failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  validateConfig();

  const { rpcUrl, networkPassphrase } = NETWORK_CONFIG[CONFIG.network];
  const keypair = Keypair.fromSecret(CONFIG.secretKey);
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║         Soroban Keeper Network — Keeper Bot v0.1.0          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Network  : ${CONFIG.network}`);
  console.log(`  RPC URL  : ${rpcUrl}`);
  console.log(`  Keeper   : ${keypair.publicKey()}`);
  console.log(`  Registry : ${CONFIG.registryContractId}`);
  console.log(`  Poll     : every ${CONFIG.pollIntervalMs / 1000}s`);
  console.log(`  Withdraw : when balance ≥ ${CONFIG.withdrawThreshold} stroops`);
  console.log("");

  // Verify connectivity
  try {
    const health = await server.getHealth();
    console.log(`✅  RPC healthy — ledger ${health.ledger}`);
  } catch (e) {
    console.error(`❌  RPC unreachable at ${rpcUrl}: ${e.message}`);
    process.exit(1);
  }

  // Run initial round immediately, then poll
  await keeperLoop(server, keypair, networkPassphrase, CONFIG.registryContractId);

  setInterval(async () => {
    try {
      await keeperLoop(server, keypair, networkPassphrase, CONFIG.registryContractId);
    } catch (err) {
      console.error("❌  Keeper loop error:", err.message);
    }
  }, CONFIG.pollIntervalMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
