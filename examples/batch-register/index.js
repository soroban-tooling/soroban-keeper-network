/**
 * Soroban Keeper Network — Batch Registration Helper
 *
 * Owner-side tooling for dApp integrators. `examples/keeper-bot` is the
 * keeper-side example — it claims and executes tasks other people registered,
 * and has no reason to register any itself. This script is the other half:
 * it takes a list of tasks a dApp wants automated and registers them all in a
 * single `batch_register_tasks` call.
 *
 * This script:
 *   1. Reads a task list from a JSON or CSV file (format: see README.md).
 *   2. Validates every entry locally against the contract's own bounds, so an
 *      obvious mistake costs you nothing instead of a failed transaction.
 *   3. Computes `max_total_reward` as the exact sum of the list (see the
 *      "Why the exact sum" note below).
 *   4. Chunks the list against the contract's live `max_batch_size()` view.
 *   5. Submits each chunk as one `batch_register_tasks` call and prints the
 *      returned task ids next to the entry that produced them.
 *
 * Usage:
 *   cp .env.example .env
 *   # Fill in your funded owner secret key and the registry contract address
 *   npm install
 *   node index.js tasks.example.json
 *
 * Dry run — validate, chunk, and print what *would* be submitted, without
 * signing or sending anything:
 *   node index.js tasks.example.json --dry-run
 *
 * Why `max_total_reward` is the exact sum, not a padded buffer 
 *
 * `max_total_reward` is a ceiling on the escrow one call may pull from the
 * owner. Because the call is atomic (docs/BATCH_OPERATIONS.md §3), there is
 * no partial-success case a buffer would rescue: either every entry registers
 * or none does. A padded ceiling therefore buys nothing and only widens the
 * window in which the transaction could move more escrow than you reviewed —
 * which is the exact risk the parameter exists to close. So this script sets
 * it to the exact sum of the chunk it is submitting, computed with BigInt so
 * a large list cannot silently lose precision, and prints that sum before
 * sending so you can eyeball it against what you expected.
 *
 * If your own workflow genuinely needs headroom (e.g. an operator appends
 * entries to the file between review and submission), set
 * MAX_TOTAL_REWARD_BUFFER_BPS in .env — it is 0 by default, deliberately, and
 * the script prints loudly when it is not.
 *
 * One transaction per chunk 
 *
 * A list longer than the contract's `MAX_BATCH_SIZE` is split into several
 * calls. Each chunk is an independent atomic transaction with its own
 * `max_total_reward` — never the sum across chunks. If chunk 3 of 5 fails,
 * chunks 1 and 2 have already landed and chunks 4 and 5 were not attempted;
 * the script reports exactly that, so you know what to resubmit.
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const stellarSdk = require("@stellar/stellar-sdk");
const {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Contract,
  StrKey,
} = stellarSdk;

// stellar-sdk 13 exports the RPC client as `rpc`; 12 and earlier used
// `SorobanRpc`. Accept either so the script runs against the locked version.
const SorobanRpc = stellarSdk.rpc || stellarSdk.SorobanRpc;

// ─────────────────────────────────────────────────────────────────────────────
// Contract-side bounds, mirrored for local pre-flight validation
//
// These duplicate constants in contracts/keeper-registry/src/lib.rs. They are
// only used to fail fast with a readable message; the contract is always the
// authority, and MAX_BATCH_SIZE specifically is read from the chain at runtime
// rather than taken from here.
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_BOUNDS = {
  MAX_CALLDATA_LEN: 1024,
  MIN_LOCK_LEDGERS: 12,
  MAX_LOCK_LEDGERS: 17_280,
  MIN_TTL_LEDGERS: 1_000,
};

/** Fallback if `max_batch_size()` is unavailable (e.g. an older deployment). */
const FALLBACK_MAX_BATCH_SIZE = 50;

/** `TaskType` variant names, in the contract's declaration order. */
const TASK_TYPES = [
  "Liquidation",
  "OraclePricePush",
  "FundingRateUpdate",
  "LiquidityRebalance",
  "TtlExtension",
  "Custom",
];

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
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`${message}`);
  process.exit(1);
}

function loadConfig(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const taskFile = args.find((a) => !a.startsWith("--"));

  if (!taskFile) {
    fail(
      "No task list given.\n" +
        "    Usage: node index.js <tasks.json|tasks.csv> [--dry-run]"
    );
  }
  if (!fs.existsSync(taskFile)) {
    fail(`Task list not found: ${taskFile}`);
  }

  const network = process.env.NETWORK || "testnet";
  if (!NETWORK_CONFIG[network]) {
    fail(
      `Invalid NETWORK: ${network} — must be one of: ${Object.keys(
        NETWORK_CONFIG
      ).join(", ")}`
    );
  }

  const registryContractId = process.env.REGISTRY_CONTRACT_ID;
  if (!registryContractId || !StrKey.isValidContract(registryContractId)) {
    fail("REGISTRY_CONTRACT_ID must be set to a valid contract ID (C...)");
  }

  // A dry run never signs, so it must not demand a secret key — that is what
  // makes it usable in CI or on a machine that has no owner key at all.
  const secretKey = process.env.OWNER_SECRET_KEY;
  if (!dryRun) {
    if (!secretKey || !StrKey.isValidEd25519SecretSeed(secretKey)) {
      fail("OWNER_SECRET_KEY must be set to a valid secret key (S...)");
    }
  }

  const bufferBps = Number(process.env.MAX_TOTAL_REWARD_BUFFER_BPS || "0");
  if (!Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > 10_000) {
    fail("MAX_TOTAL_REWARD_BUFFER_BPS must be an integer in [0, 10000]");
  }

  return { taskFile, dryRun, network, registryContractId, secretKey, bufferBps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task list parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses the task list. Format is chosen by file extension: `.csv` is treated
 * as CSV with a header row, anything else as JSON. Both produce the same
 * shape, so everything downstream only deals with one representation.
 *
 * Rewards and deadlines are kept as BigInt: rewards are i128 stroops and
 * deadlines are u64 seconds, and both can exceed what a JS number represents
 * exactly. JSON files should quote them as strings for the same reason.
 */
function parseTaskFile(taskFile) {
  const raw = fs.readFileSync(taskFile, "utf8");
  const isCsv = path.extname(taskFile).toLowerCase() === ".csv";
  const rows = isCsv ? parseCsv(raw) : parseJson(raw, taskFile);

  if (!Array.isArray(rows) || rows.length === 0) {
    fail(`${taskFile} contains no task entries.`);
  }
  return rows.map((row, i) => normalizeEntry(row, i, taskFile));
}

function parseJson(raw, taskFile) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`${taskFile} is not valid JSON: ${e.message}`);
  }
  // Accept either a bare array or `{ "tasks": [...] }`, since both shapes are
  // things a dApp's own export tooling plausibly produces.
  return Array.isArray(parsed) ? parsed : parsed.tasks;
}

/**
 * Minimal CSV reader: header row, comma-separated, optional double quotes,
 * `""` as an escaped quote. Deliberately not a full RFC 4180 parser — the
 * task list is a short operator-authored file, and pulling in a CSV
 * dependency for it would add more surface than it removes. Use JSON if your
 * calldata needs embedded newlines.
 */
function parseCsv(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 2) {
    fail("CSV needs a header row and at least one task row.");
  }

  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) {
      fail(
        `CSV row has ${cells.length} cells but the header has ${header.length}: ${line}`
      );
    }
    return Object.fromEntries(header.map((key, i) => [key, cells[i]]));
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeEntry(row, index, taskFile) {
  const where = `${taskFile} entry #${index + 1}`;

  const bigint = (field, value) => {
    if (value === undefined || value === "") {
      fail(`${where}: missing required field "${field}"`);
    }
    try {
      return BigInt(String(value).replace(/_/g, ""));
    } catch {
      fail(`${where}: "${field}" is not an integer: ${value}`);
    }
  };

  const integer = (field, value) => {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      fail(`${where}: "${field}" is not an integer: ${value}`);
    }
    return n;
  };

  const taskType = row.task_type ?? row.taskType;
  if (!TASK_TYPES.includes(taskType)) {
    fail(
      `${where}: unknown task_type "${taskType}" — must be one of: ${TASK_TYPES.join(
        ", "
      )}`
    );
  }

  // `calldata` is hex in the file (with or without a 0x prefix) so a CSV cell
  // can hold arbitrary bytes without quoting or encoding surprises. Empty
  // calldata is intentionally allowed — the contract accepts it.
  const calldataHex = String(row.calldata ?? "").replace(/^0x/i, "");
  if (calldataHex.length % 2 !== 0 || /[^0-9a-f]/i.test(calldataHex)) {
    fail(`${where}: "calldata" must be a hex string (got: ${row.calldata})`);
  }

  return {
    index,
    label: row.label ?? row.name ?? `entry #${index + 1}`,
    taskType,
    calldata: Buffer.from(calldataHex, "hex"),
    reward: bigint("reward", row.reward),
    deadline: bigint("deadline", row.deadline),
    ttlLedgers: integer("ttl_ledgers", row.ttl_ledgers ?? row.ttlLedgers),
    lockLedgers: integer("lock_ledgers", row.lock_ledgers ?? row.lockLedgers),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local pre-flight validation
//
// The contract rejects the *whole* batch if any single entry is invalid
// (docs/BATCH_OPERATIONS.md §3), so catching a bad entry here saves a failed
// transaction — and, more usefully, reports *every* bad entry at once rather
// than the first one the contract happened to hit.
// ─────────────────────────────────────────────────────────────────────────────

function validateEntries(entries, nowSeconds, minReward) {
  const problems = [];
  const note = (entry, message) =>
    problems.push(`  • ${entry.label} (entry #${entry.index + 1}): ${message}`);

  for (const entry of entries) {
    if (entry.reward <= 0n) {
      note(entry, `reward must be positive (got ${entry.reward})`);
    } else if (entry.reward < minReward) {
      note(
        entry,
        `reward ${entry.reward} is below the registry's min_reward ${minReward}`
      );
    }
    if (entry.deadline <= nowSeconds) {
      note(
        entry,
        `deadline ${entry.deadline} is not in the future (ledger time is ${nowSeconds})`
      );
    }
    if (entry.calldata.length > CONTRACT_BOUNDS.MAX_CALLDATA_LEN) {
      note(
        entry,
        `calldata is ${entry.calldata.length} bytes, over the ${CONTRACT_BOUNDS.MAX_CALLDATA_LEN}-byte limit`
      );
    }
    if (
      entry.lockLedgers < CONTRACT_BOUNDS.MIN_LOCK_LEDGERS ||
      entry.lockLedgers > CONTRACT_BOUNDS.MAX_LOCK_LEDGERS
    ) {
      note(
        entry,
        `lock_ledgers ${entry.lockLedgers} is outside [${CONTRACT_BOUNDS.MIN_LOCK_LEDGERS}, ${CONTRACT_BOUNDS.MAX_LOCK_LEDGERS}]`
      );
    }
    if (entry.ttlLedgers < CONTRACT_BOUNDS.MIN_TTL_LEDGERS) {
      note(
        entry,
        `ttl_ledgers ${entry.ttlLedgers} is below the minimum ${CONTRACT_BOUNDS.MIN_TTL_LEDGERS}`
      );
    }
  }

  if (problems.length > 0) {
    fail(
      `${problems.length} invalid entr${
        problems.length === 1 ? "y" : "ies"
      } — the contract would reject the whole batch:\n${problems.join("\n")}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Soroban helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encodes one entry as the contract's `BatchTaskParams`.
 *
 * A Soroban `#[contracttype]` struct is an `ScMap` keyed by symbol, and the
 * host requires the keys in lexicographic order — hence the ordering below,
 * which is alphabetical rather than the struct's declaration order. A unit
 * enum variant like `TaskType::Liquidation` encodes as a one-element vector
 * holding the variant's symbol.
 */
function toBatchTaskParams(entry) {
  const field = (key, val) =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: "symbol" }), val });

  return xdr.ScVal.scvMap([
    field("calldata", nativeToScVal(entry.calldata, { type: "bytes" })),
    field("deadline", nativeToScVal(entry.deadline, { type: "u64" })),
    field("lock_ledgers", nativeToScVal(entry.lockLedgers, { type: "u32" })),
    field("reward", nativeToScVal(entry.reward, { type: "i128" })),
    field(
      "task_type",
      xdr.ScVal.scvVec([nativeToScVal(entry.taskType, { type: "symbol" })])
    ),
    field("ttl_ledgers", nativeToScVal(entry.ttlLedgers, { type: "u32" })),
  ]);
}

/**
 * Evaluates a read-only contract function via simulation. No transaction is
 * signed or submitted and no sequence number is consumed — the same approach
 * examples/keeper-bot uses for its views, and why this script can read
 * `max_batch_size` and `min_reward` before it knows whether it will submit.
 */
async function readContract(server, sourcePublicKey, networkPassphrase, contractId, method, args = []) {
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

/**
 * Submits one `batch_register_tasks` call and returns the task ids it created.
 *
 * The return value is read from the transaction's result rather than from the
 * simulation, so the ids reported are the ones that actually landed on-chain.
 */
async function submitBatch(
  server,
  keypair,
  networkPassphrase,
  contractId,
  chunk,
  maxTotalReward
) {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        "batch_register_tasks",
        nativeToScVal(keypair.publicKey(), { type: "address" }),
        xdr.ScVal.scvVec(chunk.map(toBatchTaskParams)),
        nativeToScVal(maxTotalReward, { type: "i128" })
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Send failed: ${JSON.stringify(sent.errorResult)}`);
  }

  let result = await server.getTransaction(sent.hash);
  let attempts = 0;
  while (
    result.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
    attempts < 30
  ) {
    await sleep(2000);
    result = await server.getTransaction(sent.hash);
    attempts++;
  }
  if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sent.hash} failed: ${result.status}`);
  }

  const taskIds = result.returnValue ? scValToNative(result.returnValue) : [];
  return { hash: sent.hash, taskIds };
}

function chunkList(entries, size) {
  const chunks = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

function sumRewards(entries) {
  return entries.reduce((total, entry) => total + entry.reward, 0n);
}

/**
 * The ceiling for one chunk. Defaults to the exact sum — see the header
 * comment for why padding is the wrong default. A non-zero buffer is applied
 * in basis points and reported loudly by the caller.
 */
function ceilingFor(entries, bufferBps) {
  const sum = sumRewards(entries);
  if (bufferBps === 0) return sum;
  return sum + (sum * BigInt(bufferBps)) / 10_000n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig(process.argv);
  const { rpcUrl, networkPassphrase } = NETWORK_CONFIG[config.network];
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  const entries = parseTaskFile(config.taskFile);

  console.log("");
  console.log("Soroban Keeper Network — Batch Registration Helper      ");
  console.log("");
  console.log(`  Network  : ${config.network}`);
  console.log(`  Registry : ${config.registryContractId}`);
  console.log(`  Task list: ${config.taskFile} (${entries.length} entries)`);

  // Simulation still builds a transaction envelope, so reading the registry's
  // views requires a funded source account. A dry run without OWNER_SECRET_KEY
  // therefore skips the on-chain reads and validates purely locally.
  const keypair = config.secretKey ? Keypair.fromSecret(config.secretKey) : null;
  if (keypair) {
    console.log(`  Owner    : ${keypair.publicKey()}`);
  }
  if (config.dryRun) {
    console.log("  Mode     : --dry-run (nothing will be signed or sent)");
  }
  console.log("");

  // Read the contract's own limits rather than trusting the constants mirrored
  // at the top of this file — a redeployed registry may have revised them.
  let maxBatchSize = FALLBACK_MAX_BATCH_SIZE;
  let minReward = 0n;
  // Wall-clock is close enough for a pre-flight deadline check; the contract
  // compares against ledger close time, which trails it by seconds at most.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  if (keypair) {
    const source = keypair.publicKey();
    try {
      maxBatchSize = Number(
        await readContract(
          server,
          source,
          networkPassphrase,
          config.registryContractId,
          "max_batch_size"
        )
      );
    } catch (e) {
      console.warn(
        `Could not read max_batch_size() (${e.message}); falling back to ${FALLBACK_MAX_BATCH_SIZE}.`
      );
    }
    try {
      minReward = BigInt(
        await readContract(
          server,
          source,
          networkPassphrase,
          config.registryContractId,
          "min_reward"
        )
      );
    } catch (e) {
      console.warn(`Could not read min_reward() (${e.message}); assuming 0.`);
    }
  } else {
    console.log(
      `  (no OWNER_SECRET_KEY set — using MAX_BATCH_SIZE=${FALLBACK_MAX_BATCH_SIZE} and min_reward=0 for the dry run)`
    );
  }

  validateEntries(entries, nowSeconds, minReward);

  const chunks = chunkList(entries, maxBatchSize);
  const grandTotal = sumRewards(entries);

  console.log(`  Batch size limit : ${maxBatchSize} entries per call`);
  console.log(`  Transactions     : ${chunks.length}`);
  console.log(`  Total escrow     : ${grandTotal} stroops across all chunks`);
  if (config.bufferBps > 0) {
    console.log(
      `  max_total_reward padded by ${config.bufferBps} bps above each chunk's sum.\n` +
        "      The default is 0 (exact sum) — see this file's header for why."
    );
  }
  console.log("");

  if (config.dryRun) {
    chunks.forEach((chunk, i) => {
      console.log(
        `  Chunk ${i + 1}/${chunks.length}: ${chunk.length} entries, ` +
          `max_total_reward=${ceilingFor(chunk, config.bufferBps)}`
      );
      for (const entry of chunk) {
        console.log(
          `    - ${entry.label}: ${entry.taskType}, reward=${entry.reward}, ` +
            `deadline=${entry.deadline}, calldata=${entry.calldata.length}B`
        );
      }
    });
    console.log("\nDry run complete — nothing was submitted.");
    return;
  }

  const registered = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const ceiling = ceilingFor(chunk, config.bufferBps);
    console.log(
      `Chunk ${i + 1}/${chunks.length}: ${chunk.length} entries, max_total_reward=${ceiling}`
    );

    let result;
    try {
      result = await submitBatch(
        server,
        keypair,
        networkPassphrase,
        config.registryContractId,
        chunk,
        ceiling
      );
    } catch (err) {
      // Every chunk is its own atomic transaction: this one registered
      // nothing, earlier ones already landed, later ones were not attempted.
      console.error(`Chunk ${i + 1} failed: ${err.message}`);
      console.error(
        `    Zero tasks from this chunk were registered and no escrow moved.\n` +
          `    Chunks 1..${i} already landed; chunks ${i + 2}..${chunks.length} were not attempted.\n` +
          `    Fix the flagged entry and resubmit a file containing only entries ${
            chunk[0].index + 1
          }..${entries.length}.`
      );
      reportRegistered(registered);
      process.exit(1);
    }

    console.log(`   tx ${result.hash}`);
    result.taskIds.forEach((taskId, j) => {
      registered.push({ entry: chunk[j], taskId: String(taskId) });
    });
  }

  reportRegistered(registered);
  console.log(`\nRegistered ${registered.length} task(s).`);
}

/** Prints each returned task id next to the entry that produced it. */
function reportRegistered(registered) {
  if (registered.length === 0) {
    console.log("\n  No tasks were registered.");
    return;
  }
  console.log("\n  Task id  Entry");
  console.log("  ");
  for (const { entry, taskId } of registered) {
    console.log(`  ${String(taskId).padStart(7)}  ${entry.label}`);
  }
}

module.exports = {
  parseTaskFile,
  parseCsv,
  normalizeEntry,
  validateEntries,
  chunkList,
  sumRewards,
  ceilingFor,
  CONTRACT_BOUNDS,
  TASK_TYPES,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
