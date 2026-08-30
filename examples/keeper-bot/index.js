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
 * Usage (daemon mode):
 *   cp .env.example .env
 *   # Fill in your secret key and contract address
 *   npm install
 *   node index.js
 *
 * Usage (one-shot mode for cron or serverless):
 *   node index.js --once
 *   # or: RUN_ONCE=true node index.js
 *
 * This example already includes:
 *   - Comprehensive startup validation for all config settings
 *   - Retry with exponential back-off + jitter on transient RPC errors
 *   - Graceful shutdown (SIGINT/SIGTERM) that drains the in-flight round
 *   - Permissionless expiry of stale tasks to refund owners
 *   - Read-only views (`keeper_balance`, etc.) are evaluated via simulation
 *     through `readContract`, not submitted as signed transactions — see
 *     that function's doc comment for why this matters
 *   - A pluggable executor interface (see EXECUTORS below) — off-chain
 *     execution is dispatched per task_type to a registered executor, and
 *     execute_task is never submitted for a task type with no executor or
 *     whose executor could not complete the work
 *
 * Production keepers should additionally add:
 *   - Persistent task state DB (SQLite / Redis) to avoid double-claiming
 *   - MEV-aware submission (bundle multiple tasks)
 *   - Prometheus metrics endpoint
 *   - Alerting (PagerDuty / Telegram) on missed executions
 */

"use strict";

require("dotenv").config();

const {
  Keypair,
  rpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Contract,
} = require("@stellar/stellar-sdk");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — set via environment variables or .env file
// ─────────────────────────────────────────────────────────────────────────────

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

let CONFIG; // Initialized in main() after validation

// ─────────────────────────────────────────────────────────────────────────────
// Configuration validation
// ─────────────────────────────────────────────────────────────────────────────

function fail(name, value, reason) {
  let message = `Invalid ${name}`;
  if (value) {
    message += `: ${value}`;
  }
  console.error(`${message} — ${reason}`);
  process.exit(1);
}

function requireEnv(name, { parse, validate, secret = false, fallback }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    fail(name, raw, "must be set");
  }
  try {
    const parsed = parse ? parse(raw) : raw;
    if (validate && !validate.fn(parsed)) {
      fail(name, secret ? null : raw, validate.reason);
    }
    return parsed;
  } catch (e) {
    fail(name, secret ? null : raw, e.message);
  }
}

async function validateAndLoadConfig() {
  const { StrKey } = require("@stellar/stellar-sdk"); // Moved inside to be used only here
  const network = requireEnv("NETWORK", {
    validate: {
      fn: (v) => Object.keys(NETWORK_CONFIG).includes(v),
      reason: `must be one of: ${Object.keys(NETWORK_CONFIG).join(", ")}`,
    },
    fallback: "testnet",
  });

  const registryContractId = requireEnv("REGISTRY_CONTRACT_ID", {
    validate: {
      fn: StrKey.isValidContract,
      reason: "must be a valid contract ID (starts with C...)",
    },
  });

  const secretKey = requireEnv("KEEPER_SECRET_KEY", {
    secret: true,
    validate: {
      fn: StrKey.isValidEd25519SecretSeed,
      reason: "must be a valid secret key (starts with S...)",
    },
  });

  // After validating the required string values, we can create the server
  // connection and use it to validate the contract's existence on the network.
  const { rpcUrl } = NETWORK_CONFIG[network];
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  try {
    await server.getContractData(registryContractId);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      fail(
        "REGISTRY_CONTRACT_ID",
        registryContractId,
        `not found on network ${network}. Please check the contract ID and NETWORK settings.`
      );
    }
    // For other errors, we'll let the main connectivity check handle it.
  }

  // Now that all critical configs are validated, build the final CONFIG object.
  CONFIG = {
    network,
    registryContractId,
    secretKey,
    once: process.argv.includes("--once") || process.env.RUN_ONCE === "true",
    pollIntervalMs: requireEnv("POLL_INTERVAL_MS", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => v >= 1000, reason: "must be >= 1000" },
      fallback: 10000,
    }),
    withdrawThreshold: requireEnv("WITHDRAW_THRESHOLD", {
      parse: BigInt,
      validate: { fn: (v) => v >= 0, reason: "must be a positive number" },
      fallback: 10000000n,
    }),
    maxTasksPerRound: requireEnv("MAX_TASKS_PER_ROUND", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => v >= 1, reason: "must be >= 1" },
      fallback: 5,
    }),
    maxRetries: requireEnv("MAX_RETRIES", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => v >= 0, reason: "must be >= 0" },
      fallback: 3,
    }),
    retryBaseMs: requireEnv("RETRY_BASE_MS", {
      parse: (v) => parseInt(v, 10),
      validate: { fn: (v) => v > 0, reason: "must be > 0" },
      fallback: 500,
    }),
    expireStaleTasks: requireEnv("EXPIRE_STALE_TASKS", {
      parse: (v) => v.toLowerCase() === "true",
      fallback: true,
    }),
    // Development only — see the EXECUTORS section below and .env.example
    // for the accompanying warning. Never the default: a keeper with this
    // unset and no real executor registered for a task type simply skips
    // that task rather than fabricating a proof.
    simulateExecution: requireEnv("SIMULATE_EXECUTION", {
      parse: (v) => v.toLowerCase() === "true",
      fallback: false,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reliability helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retries an async operation with exponential back-off and jitter.
 *
 * Only transient failures (RPC timeouts, network blips, transaction not-yet-
 * confirmed) should be retried. Deterministic contract errors — e.g. a task
 * already claimed by another keeper — are surfaced immediately so we don't
 * waste fees resubmitting a call that can never succeed.
 */
async function withRetry(label, fn, options = {}) {
  // The retry policy and the sleep function are injectable so the unit tests
  // can drive this without a loaded CONFIG and without real waiting. Callers
  // in this file pass nothing and get the configured behaviour.
  const {
    maxRetries = CONFIG.maxRetries,
    retryBaseMs = CONFIG.retryBaseMs,
    sleepFn = sleep,
  } = options;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isPermanentError(err) || attempt === maxRetries) {
        throw err;
      }
      const backoff = retryBaseMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * retryBaseMs);
      const delay = backoff + jitter;
      console.warn(
        `${label} failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${err.message}`
      );
      await sleepFn(delay);
    }
  }
  throw lastErr;
}

/**
 * Heuristic: contract-level business errors are permanent for this bot and must
 * not be retried, whereas transport/consensus errors are worth another attempt.
 */
function isPermanentError(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return (
    msg.includes("simulation failed") || // contract returned an Err()
    msg.includes("invalidaction") ||
    msg.includes("unauthorized") ||
    msg.includes("already")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Soroban helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SYMBOL_LENGTH = 9;

/**
 * Encodes a Soroban symbol as the base64 XDR string `getEvents` expects for a
 * topic filter. Derived at runtime so the filter always matches the symbol
 * written here, and a contract-side rename surfaces as a code change rather
 * than a filter that silently stops matching.
 */
function topicSymbol(name) {
  if (name.length > MAX_SYMBOL_LENGTH) {
    throw new Error(
      `Symbol "${name}" is too long; max ${MAX_SYMBOL_LENGTH} chars`
    );
  }
  return nativeToScVal(name, { type: "symbol" }).toXDR("base64");
}

/**
 * Event topic filters, derived from runtime symbol names.
 * Cross-references:
 *  - `taskRegistered`: `contracts/keeper-registry/src/lib.rs`, `emit_task_registered`
 */
const REGISTRY_EVENTS = {
  taskRegistered: [topicSymbol("reg"), topicSymbol("task")],
};

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

/**
 * Evaluates a read-only contract function via simulation.
 *
 * No transaction is signed, submitted, or confirmed, and no sequence number
 * is consumed — this is safe (and cheap) to call on every polling round.
 * Use `invokeContract` instead for anything that mutates state, since that
 * is the only path that actually submits.
 *
 * Note: simulation still builds a transaction envelope, so `server.getAccount`
 * requires the source account to already exist (be funded) on-chain — the
 * same requirement `invokeContract` has today. A brand-new, unfunded keeper
 * key will throw here.
 */
async function readContract(server, sourcePublicKey, networkPassphrase, contractId, method, args) {
  const account = await server.getAccount(sourcePublicKey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  return sim.result ? scValToNative(sim.result.retval) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task fetching — reads pending tasks by querying events
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPendingTasks(server, contractId, startLedger) {
  try {
    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
          // See REGISTRY_EVENTS for how these topics are derived.
          topics: [REGISTRY_EVENTS.taskRegistered],
        },
      ],
      limit: 100,
    });

    const tasks = [];
    let skipped = 0;
    for (const event of response.events || []) {
      try {
        // The `TaskRegistered` event data is a 4-tuple:
        //   (task_id: u64, owner: Address, reward: i128, deadline: u64)
        // See `contracts/keeper-registry/src/lib.rs`, `emit_task_registered`.
        // The owner is not needed by the keeper, so we skip it.
        const [taskIdVal, , rewardVal, deadlineVal] = event.value.value();
        const taskId = scValToNative(taskIdVal);
        const reward = scValToNative(rewardVal);
        const deadline = scValToNative(deadlineVal);

        tasks.push({ taskId, reward, deadline });
      } catch (err) {
        skipped++;
        if (skipped === 1) {
          // Log the first failure in full — if the event shape has changed, one
          // decoded error is worth more than a hundred counted ones.
          console.warn(`Could not decode a TaskRegistered event: ${err.message}`);
        }
      }
    }
    if (skipped > 0) {
      console.warn(`Skipped ${skipped} undecodable event(s) — the contract's event shape may have changed.`);
    }
    return tasks;
  } catch (err) {
    console.warn("Failed to fetch events:", err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor interface — pluggable off-chain execution, dispatched by task_type
// ─────────────────────────────────────────────────────────────────────────────
//
// A task executor performs the off-chain work a task describes and returns
// evidence that it happened.
//
//   @param {object} task
//     { taskId, taskType, taskTypeName, calldata (Buffer), reward, deadline }
//   @param {object} ctx
//     { server, keypair, networkPassphrase, log }
//   @returns {Promise<Buffer|null>}
//     Proof bytes on success; `null` if the work could not be completed.
//     Returning `null` means the bot will NOT call execute_task — the task
//     is left for another keeper or for expiry. Throwing is treated the
//     same way, with the error logged.
//
// Register executors by task_type below. There is deliberately no default
// executor that fabricates a proof: a keeper that submits proof for work it
// did not do is exactly the failure mode the registry's trust model warns
// about (see README.md, "Known Design Decisions" #1), so an unhandled task
// type is skipped, not faked.

/**
 * Maps the contract's `TaskType` enum (see `contracts/keeper-registry/src/lib.rs`)
 * to readable names, for logging and executor lookup.
 */
const TASK_TYPE_NAMES = {
  0: "Liquidation",
  1: "OraclePricePush",
  2: "FundingRateUpdate",
  3: "LiquidityRebalance",
  4: "TtlExtension",
  5: "Custom",
};

/**
 * Worked example: an executor for TaskType::TtlExtension. This task type's
 * calldata is expected to be empty (see the contract's TaskType doc) — the
 * "work" is simply confirming the task is still within its own deadline,
 * which is the kind of no-op-but-verifiable action this task type exists
 * for. A real executor for Liquidation/OraclePricePush/etc. would instead
 * decode `task.calldata` into a target contract call and submit it.
 */
async function ttlExtensionExecutor(task, ctx) {
  ctx.log(`  Executing TtlExtension task ${task.taskId}...`);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (task.deadline <= nowSeconds) {
    ctx.log(`  Task ${task.taskId} deadline already passed — refusing to fabricate proof.`);
    return null;
  }
  return Buffer.from(`ttl-extension:task:${task.taskId}:confirmed-live`);
}

/**
 * Development-only synthetic executor. Returns a proof without doing any
 * real off-chain work. Enabled only via SIMULATE_EXECUTION=true so it can
 * never be the accidental default for a real deployment — see
 * `.env.example` for the accompanying warning.
 */
async function simulatedExecutor(task, ctx) {
  ctx.log(`  [SIMULATE_EXECUTION] Fabricating proof for task ${task.taskId} — NOT real execution.`);
  await sleep(500);
  return Buffer.from(`keeper-proof:task:${task.taskId}:ts:${Date.now()}`);
}

/**
 * Executors registered per task_type. No default: an unhandled task type is
 * refused, not faked.
 */
const EXECUTORS = {
  TtlExtension: ttlExtensionExecutor,
};

/**
 * Dispatches a task to its registered executor. Returns `null` (never
 * throws) when there is no executor for the task's type, when
 * `simulateExecution` is false and no real executor is registered, or when
 * the executor itself throws — in every case the caller must not submit
 * execute_task.
 *
 * `simulateExecution` is threaded through explicitly (rather than read from
 * the module-level CONFIG) so this function has no dependency on CONFIG
 * having been initialized — CONFIG is only populated by
 * validateAndLoadConfig() inside main(), which unit tests importing this
 * function directly do not run.
 */
async function executeTaskOffChain(task, ctx, simulateExecution) {
  const executor = EXECUTORS[task.taskTypeName];

  if (!executor) {
    if (simulateExecution) {
      return simulatedExecutor(task, ctx);
    }
    ctx.log(
      `  No executor registered for task type ${task.taskTypeName} (task ${task.taskId}) — skipping.`
    );
    return null;
  }

  try {
    return await executor(task, ctx);
  } catch (err) {
    ctx.log(`  Executor for task ${task.taskId} threw: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main keeper loop
// ─────────────────────────────────────────────────────────────────────────────

async function keeperLoop(
  server,
  keypair,
  networkPassphrase,
  contractId,
  emptyRounds = 0
) {
  // A round is successful if it runs to completion without any unhandled
  // exceptions. An RPC error that cannot be resolved with retries, or any
  // other unexpected error, is a failure.
  // Note: a round that finds no tasks is a success. Losing a claim race to
  // another keeper is also a success, as this is normal competitive behaviour.
  const summary = { processed: 0, errors: [] };
  let newEmptyRounds = emptyRounds;

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    console.log(`\nKeeper round at ${new Date().toISOString()}`);

    const latestLedger = await server.getLatestLedger();
    const startLedger = Math.max(1, latestLedger.sequence - 1000);

    const pendingTasks = await fetchPendingTasks(
      server,
      contractId,
      startLedger
    );
    console.log(
      `  Found ${pendingTasks.length} TaskRegistered events to evaluate`
    );

    if (pendingTasks.length === 0) {
      newEmptyRounds++;
      if (newEmptyRounds > 0 && newEmptyRounds % 30 === 0) {
        console.warn(
          `  No TaskRegistered events found for ${newEmptyRounds} consecutive rounds.`
        );
      }
    } else {
      newEmptyRounds = 0;
    }

    for (const task of pendingTasks) {
      if (summary.processed >= CONFIG.maxTasksPerRound) break;

      if (task.deadline <= nowSeconds) {
        if (CONFIG.expireStaleTasks) {
          try {
            await withRetry(`expire_task ${task.taskId}`, () =>
              invokeContract(
                server,
                keypair,
                networkPassphrase,
                contractId,
                "expire_task",
                [nativeToScVal(task.taskId, { type: "u64" })]
              )
            );
            console.log(
              `  Task ${task.taskId} expired — escrow refunded to owner`
            );
          } catch (err) {
            console.log(
              `  Task ${task.taskId} past deadline (skip: ${err.message})`
            );
          }
        } else {
          console.log(`  Task ${task.taskId} is past deadline, skipping`);
        }
        continue;
      }

      try {
        console.log(
          `  Attempting to claim task ${task.taskId} (reward: ${task.reward})...`
        );
        await withRetry(`claim_task ${task.taskId}`, () =>
          invokeContract(
            server,
            keypair,
            networkPassphrase,
            contractId,
            "claim_task",
            [
              nativeToScVal(keypair.publicKey(), { type: "address" }),
              nativeToScVal(task.taskId, { type: "u64" }),
            ]
          )
        );
        console.log(`  Task ${task.taskId} claimed!`);

        // Fetch full task details — the TaskRegistered event decoded in
        // fetchPendingTasks carries only { taskId, reward, deadline }, but
        // an executor needs task_type and calldata to know what off-chain
        // work to perform.
        const fullTask = await readContract(
          server,
          keypair.publicKey(),
          networkPassphrase,
          contractId,
          "get_task",
          [nativeToScVal(task.taskId, { type: "u64" })]
        );
        const taskType = fullTask.task_type;
        const taskTypeName = TASK_TYPE_NAMES[taskType] || `Unknown(${taskType})`;

        const executorCtx = {
          server,
          keypair,
          networkPassphrase,
          log: (msg) => console.log(msg),
        };
        const proof = await executeTaskOffChain(
          {
            taskId: task.taskId,
            taskType,
            taskTypeName,
            calldata: fullTask.calldata,
            reward: task.reward,
            deadline: task.deadline,
          },
          executorCtx,
          CONFIG.simulateExecution
        );

        if (proof === null || proof === undefined) {
          console.log(
            `  Task ${task.taskId} (${taskTypeName}) not executed — leaving claimed for expiry or another keeper.`
          );
          continue;
        }

        if (proof === null || proof === undefined) {
          console.log(
            `  Task ${task.taskId} (${taskTypeName}) not executed — leaving claimed for expiry or another keeper.`
          );
          continue;
        }

        await withRetry(`execute_task ${task.taskId}`, () =>
          invokeContract(
            server,
            keypair,
            networkPassphrase,
            contractId,
            "execute_task",
            [
              nativeToScVal(keypair.publicKey(), { type: "address" }),
              nativeToScVal(task.taskId, { type: "u64" }),
              nativeToScVal(proof, { type: "bytes" }),
            ]
          )
        );
        console.log(
          `  Task ${task.taskId} executed! Proof: ${proof.toString("hex").slice(0, 20)}...`
        );
        summary.processed++;
      } catch (err) {
        console.warn(
          `  Failed to process task ${task.taskId}: ${err.message}`
        );
        summary.errors.push(err);
      }
    }
  } catch (err) {
    console.error(`Keeper loop error: ${err.message}`);
    summary.errors.push(err);
  }

  // Check accumulated rewards and withdraw if above threshold. This is a
  // read-only view, so it goes through `readContract` (simulation only) and
  // costs nothing — no fee, no sequence number, no submitted transaction.
  // We still check it every round rather than tracking the balance locally:
  // simulation makes the read free enough that the extra round-trip isn't
  // worth trading away the guarantee of reading current on-chain state.
  try {
    const rawBalance = await readContract(
      server,
      keypair.publicKey(),
      networkPassphrase,
      contractId,
      "keeper_balance",
      [nativeToScVal(keypair.publicKey(), { type: "address" })]
    );
    const balance = BigInt(rawBalance || 0);
    console.log(`  Accumulated reward balance: ${balance} stroops`);

    if (balance >= CONFIG.withdrawThreshold) {
      console.log(`  Withdrawing ${balance} stroops...`);
      // withdraw_rewards mutates state, so it still goes through the
      // submitting path.
      await invokeContract(
        server,
        keypair,
        networkPassphrase,
        contractId,
        "withdraw_rewards",
        [nativeToScVal(keypair.publicKey(), { type: "address" })]
      );
      console.log(`  Withdrawal complete!`);
    }
  } catch (err) {
    console.warn(`  Balance check failed: ${err.message}`);
    summary.errors.push(err);
  }
  return { summary, emptyRounds: newEmptyRounds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await validateAndLoadConfig();

  const { rpcUrl, networkPassphrase } = NETWORK_CONFIG[CONFIG.network];
  const keypair = Keypair.fromSecret(CONFIG.secretKey);
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  console.log("");
  console.log("Soroban Keeper Network — Keeper Bot v0.1.0          ");
  console.log("");
  console.log(`  Network  : ${CONFIG.network}`);
  console.log(`  RPC URL  : ${rpcUrl}`);
  console.log(`  Keeper   : ${keypair.publicKey()}`);
  console.log(`  Registry : ${CONFIG.registryContractId}`);
  if (CONFIG.once) {
    console.log("  Mode     : --once (single run)");
  } else {
    console.log(`  Poll     : every ${CONFIG.pollIntervalMs / 1000}s`);
  }
  console.log(`  Withdraw : when balance ≥ ${CONFIG.withdrawThreshold} stroops`);
  console.log("");

  // Verify connectivity
  try {
    const health = await server.getHealth();
    console.log(`RPC healthy — ledger ${health.ledger}`);
  } catch (e) {
    console.error(`RPC unreachable at ${rpcUrl}: ${e.message}`);
    process.exit(1);
  }

  if (CONFIG.once) {
    const { summary } = await keeperLoop(
      server,
      keypair,
      networkPassphrase,
      CONFIG.registryContractId
    );
    const ok = summary.errors.length === 0;
    console.log(ok ? "Round complete." : "Round completed with errors.");
    process.exit(ok ? 0 : 1);
  }

  // Graceful shutdown for daemon mode
  let shuttingDown = false;
  let roundInFlight = false;
  let emptyRounds = 0;
  let timer = null;

  function requestShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — finishing current round then exiting...`);
    if (timer) clearInterval(timer);
    if (!roundInFlight) {
      console.log("Clean shutdown.");
      process.exit(0);
    }
  }
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  async function runDaemonRound() {
    if (shuttingDown || roundInFlight) return;
    roundInFlight = true;
    try {
      const { summary, emptyRounds: newEmptyRounds } = await keeperLoop(
        server,
        keypair,
        networkPassphrase,
        CONFIG.registryContractId,
        emptyRounds
      );
      emptyRounds = newEmptyRounds;
      if (summary.errors.length > 0) {
        console.error(
          `Keeper round finished with ${summary.errors.length} error(s)`
        );
      }
    } catch (err) {
      // This is for truly unexpected errors in the loop itself
      console.error("Fatal keeper loop error:", err.message);
    } finally {
      roundInFlight = false;
      if (shuttingDown) {
        console.log("Clean shutdown.");
        process.exit(0);
      }
    }
  }

  // Run initial round immediately, then poll.
  await runDaemonRound();
  timer = setInterval(runDaemonRound, CONFIG.pollIntervalMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Module exports for testing
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  isPermanentError,
  withRetry,
  fetchPendingTasks,
  validateAndLoadConfig,
  keeperLoop,
  sleep,
  TASK_TYPE_NAMES,
  EXECUTORS,
  executeTaskOffChain,
  ttlExtensionExecutor,
  simulatedExecutor,
};

// Only run main() when executed directly, not when imported for testing
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
