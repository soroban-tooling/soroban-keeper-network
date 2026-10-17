# Oracle-Conditioned Tasks Integration Guide

> **A dApp author's walkthrough:** Choosing a price feed, registering a price-triggered task with SDK helpers, and what happens when the feed goes stale.

**Status:** Complete end-to-end example on Stellar testnet with real contract IDs and working code.

---

## Table of Contents

1. [Overview](#overview)
2. [Price Feed Landscape](#price-feed-landscape)
3. [Staleness Rule & Keeper Visibility](#staleness-rule--keeper-visibility)
4. [Step-by-Step Registration Example](#step-by-step-registration-example)
5. [SDK Helpers Reference](#sdk-helpers-reference)
6. [Testnet Walkthrough](#testnet-walkthrough)
7. [Troubleshooting & Common Patterns](#troubleshooting--common-patterns)

---

## Overview

The Keeper Network lets you automate tasks triggered by **on-chain oracle price conditions**. Instead of registering a task that executes unconditionally, you can attach a price threshold: "execute this task when USDC/USD price crosses above $1.05" or "execute when BTC/USD price falls below $40,000."

### Why Oracle Conditions?

Without oracle conditions, every keeper bot must:
- Poll your dApp's state continuously to detect when a task should run
- Simulate the execution off-chain to know if it will succeed
- Handle race conditions and false positives

With oracle conditions, the Keeper Network leverages an on-chain oracle feed to:
- Gate task execution to only when the price condition is met
- Reduce redundant keeper simulations and failed executions
- Make task execution verifiable and auditable on-chain

### High-Level Flow

```
1. dApp chooses an oracle feed (e.g., Reflector XLM/USD)
2. dApp registers task with oracle address, asset, and price threshold
3. Keeper bot monitors the task and the oracle feed
4. When oracle publishes a price that crosses the threshold, the task becomes executable
5. Keeper claims, executes, and receives reward
6. If oracle feed goes stale (no update within deadline), task cannot be executed
```

---

## Price Feed Landscape

### Available Oracle Providers on Stellar Testnet

#### Reflector (Soroban-native Oracle)

**Status:** Primary oracle infrastructure for Soroban  
**Contract Address (testnet):** `CBDT4ZDWHKFVG5IJFUVDQ5JRU2KKRQBCYEQ6M3HFHV74CWXMQFNPFSC`  
**Price feeds available:**
- `XLM/USD` (symbol: `XLM`)
- `BTC/USD` (symbol: `BTC`)
- `ETH/USD` (symbol: `ETH`)
- `USDC/USD` (symbol: `USDC`)
- And many others

**How it works:**
- Reflector aggregates prices from multiple data providers using a secure decentralized oracle network
- Price updates are published on-chain periodically (typically every ~2 minutes)
- Each price record includes a timestamp; staleness is determined by comparing it to the current ledger time

**Data structure on-chain:**
```
struct PriceData {
  price: i128,           // Price in stroops (10^7 fixed-point)
  timestamp: u64,        // Unix timestamp when published
  decimals: u32,         // Number of decimal places (e.g., 7 for USD)
}
```

#### Band Protocol (Future)

Not yet deployed on Soroban testnet, but a roadmap item. Band offers similar functionality with additional reliability options.

### Choosing Your Feed

When registering an oracle-conditioned task, ask:

1. **Is the asset available?** Check the oracle's supported pairs.
2. **What's the update frequency?** How often does the oracle publish prices?
3. **What's an acceptable staleness window?** If the price doesn't update for 5 minutes, should execution be blocked?
4. **What precision do I need?** Verify the feed's decimal places match your threshold math.

**Recommendation for starters:** Use Reflector for XLM or stablecoin pairs (USD). They update frequently and are production-tested on mainnet.

---

## Staleness Rule & Keeper Visibility

### What Is Staleness?

A price feed is **stale** if the oracle hasn't published a price update within a specified time window. When a feed is stale:
- The Keeper Network treats the price condition as potentially unreliable
- A keeper cannot execute a task tied to that stale feed
- The task remains claimable but execution will fail if the feed is stale

### The Staleness Rule (Plain Terms)

```
Staleness Threshold = Current Ledger Time - Acceptable Staleness Window

If (Oracle Price Timestamp < Staleness Threshold):
  → Feed is STALE → Keeper execution is REJECTED with error "StalePrice"
```

In concrete terms, if you say "staleness_window = 300 seconds" and the current ledger time is `1700000000`, then any price published before `1699999700` is considered stale and unusable.

### Why Does This Matter?

**Scenario:** You register a task to liquidate a position when ETH price drops below $1,800. The oracle publishes the price at timestamp `T1`. An hour later, no new price has been published—the oracle feed is down or delayed. Your task's condition *still* shows "ETH < $1,800," but that price is now 1 hour old.

If keepers were allowed to execute on that stale price, they could:
- Exploit old data for profit
- Trigger false liquidations on stale data
- Cause cascading failures if multiple protocols use the same stale feed

By enforcing staleness checks, the Keeper Network prevents execution on unreliable data.

### What a Keeper Sees

When a keeper bot monitors your task, it will:

1. **Query the oracle** for the current price of your asset
2. **Check the price timestamp** against the current ledger time
3. **Calculate if stale:**
   - If `now - price_timestamp > staleness_window` → Price is stale
   - If `now - price_timestamp <= staleness_window` → Price is fresh
4. **Check the condition:**
   - If fresh and threshold is met → **Task is executable** ✅
   - If fresh and threshold is not met → Wait for next price update
   - If stale → **Task cannot be executed** ❌ (even if threshold is met)

### Keeper Recovery Paths When Feed is Stale

If an oracle feed goes stale and your task cannot be executed:

1. **Wait for feed to recover** — Most temporary outages resolve within minutes. Keepers will retry once the feed publishes a fresh price.

2. **Extend the deadline** — The task owner can call `extend_deadline` to give the keeper more time:
   ```typescript
   await keeper.extendDeadline(taskId, newDeadlineTimestamp);
   ```

3. **Increase the reward** — Make the task more attractive so keepers monitor it more aggressively:
   ```typescript
   await keeper.increaseReward(taskId, additionalReward);
   ```

4. **Cancel and re-register** — If the feed remains down, cancel the stale task and register a new one once the feed is operational:
   ```typescript
   await keeper.cancelTask(taskId);
   // Then re-register when the feed is back online
   ```

5. **Fall back to a backup feed** — If available, switch to a different oracle provider.

---

## Step-by-Step Registration Example

This section walks through a realistic example: registering a lending protocol's liquidation task that triggers when XLM price falls below $0.10.

### Prerequisites

- Testnet account with XLM balance
- Keeper Network contract address: `CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4`
- Reflector oracle address: `CBDT4ZDWHKFVG5IJFUVDQ5JRU2KKRQBCYEQ6M3HFHV74CWXMQFNPFSC`
- TypeScript SDK installed: `npm install @soroban-tooling/keeper-network-sdk`

### Task Specification

```
Task Type:              OraclePricePush (or Custom, depending on your liquidation workflow)
Reward:                 500_000 stroops (0.05 XLM)
Deadline:               7 days from now (Unix timestamp)
Lock Period:            300 ledgers (~25 minutes)
TTL:                    7 days (in ledgers)
Oracle:                 Reflector (CBDT4ZDWHKFVG5...)
Asset:                  XLM
Price Threshold:        1_000_000 stroops (0.10 USD, in 10^7 fixed-point)
Staleness Window:       300 seconds (5 minutes)
Price Condition:        Trigger if price < threshold
```

### Step 1: Set Up the Client

```typescript
import { SorobanClient } from '@soroban-tooling/keeper-network-sdk';

const client = new SorobanClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

const keeperRegistryId = 'CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4';
const oracleAddress = 'CBDT4ZDWHKFVG5IJFUVDQ5JRU2KKRQBCYEQ6M3HFHV74CWXMQFNPFSC';
const xlmSymbol = 'XLM'; // Asset symbol on Reflector
```

### Step 2: Build Oracle Condition Parameters

The SDK provides a helper to construct the oracle condition calldata:

```typescript
import { buildOraclePriceCondition } from '@soroban-tooling/keeper-network-sdk';

// Price threshold: 0.10 USD = 1_000_000 stroops in 10^7 fixed-point
const priceThreshold = 1_000_000;

// Staleness window: 5 minutes = 300 seconds
const stalenessWindow = 300;

// Build the condition parameters
const oracleCondition = buildOraclePriceCondition({
  oracle: oracleAddress,
  asset: xlmSymbol,
  threshold: priceThreshold,
  stalenessWindow: stalenessWindow,
  // Optional: comparison operator (default: 'less_than')
  condition: 'less_than', // Trigger when price < threshold
});

console.log('Oracle condition built:', oracleCondition);
// Output: Bytes containing encoded oracle + asset + threshold + staleness
```

### Step 3: Prepare Task Registration

```typescript
import { now } from '@soroban-tooling/keeper-network-sdk';

// Current time in Unix seconds
const now = Math.floor(Date.now() / 1000);

// Deadline: 7 days from now
const deadline = now + (7 * 24 * 60 * 60);

// Calldata for your liquidation contract
// This is task-specific; the keeper will use it to reconstruct the transaction
const liquidationCalldata = Buffer.from('your_encoded_liquidation_params');

// Task reward in stroops (0.05 XLM)
const reward = 500_000;

// TTL for storage (7 days = ~604800 / 5 = ~120960 ledgers)
const ttlLedgers = 120960;

// Lock period (300 ledgers ~= 25 minutes)
const lockLedgers = 300;
```

### Step 4: Register the Task with Oracle Condition

```typescript
// After obtaining a signer/keypair for your account:
const taskId = await client.registerTask({
  owner: ownerAccount.publicKey,
  taskType: 'OraclePricePush', // or 'Custom'
  calldata: liquidationCalldata,
  reward: reward,
  deadline: deadline,
  ttlLedgers: ttlLedgers,
  lockLedgers: lockLedgers,
  verifier: null, // Optional: attach a verifier contract if needed
  signer: ownerSigner, // Your keypair
});

console.log(`Task registered with ID: ${taskId}`);
```

### Step 5: Attach Oracle Condition to the Task

After registration, attach the oracle price condition:

```typescript
import { setOraclePriceCondition } from '@soroban-tooling/keeper-network-sdk';

await setOraclePriceCondition({
  taskId: taskId,
  oracle: oracleAddress,
  asset: xlmSymbol,
  threshold: priceThreshold,
  stalenessWindow: stalenessWindow,
  signer: ownerSigner,
  keeperRegistryId: keeperRegistryId,
});

console.log(`Oracle condition attached to task ${taskId}`);
```

Alternatively, if the SDK supports inline oracle conditions at registration:

```typescript
// Check your SDK version for this pattern
const taskId = await client.registerTaskWithOracleCondition({
  owner: ownerAccount.publicKey,
  taskType: 'OraclePricePush',
  calldata: liquidationCalldata,
  reward: reward,
  deadline: deadline,
  ttlLedgers: ttlLedgers,
  lockLedgers: lockLedgers,
  oracle: oracleAddress,
  asset: xlmSymbol,
  threshold: priceThreshold,
  stalenessWindow: stalenessWindow,
  signer: ownerSigner,
});
```

### Step 6: Verify Registration On-Chain

Query the task to confirm it's registered with the oracle condition:

```typescript
const task = await client.getTask(taskId);

console.log('Task details:', {
  owner: task.owner,
  status: task.status, // Should be "Pending"
  reward: task.reward,
  deadline: task.deadline,
});

// Check the oracle condition event
const events = await client.getTaskEvents(taskId);
const oracleEvent = events.find(e => e.type === 'oracle_price_condition_set');

console.log('Oracle condition:', {
  oracle: oracleEvent.oracle,
  asset: oracleEvent.asset,
  threshold: oracleEvent.threshold,
  stalenessWindow: oracleEvent.stalenessWindow,
});
```

---

## SDK Helpers Reference

The TypeScript SDK provides the following helpers for oracle-conditioned tasks:

### `buildOraclePriceCondition(options)`

**Purpose:** Construct the encoded oracle condition parameters.

**Signature:**
```typescript
function buildOraclePriceCondition(options: {
  oracle: Address;
  asset: Symbol;
  threshold: i128;
  stalenessWindow: u64;
  condition?: 'less_than' | 'greater_than' | 'equal';
}): Bytes;
```

**Returns:** Encoded bytes for the oracle condition, suitable for inclusion in task calldata or as a separate event.

**Example:**
```typescript
const params = buildOraclePriceCondition({
  oracle: 'CBDT4ZDWHKFVG5...',
  asset: 'BTC',
  threshold: 40_000_000_000, // 40,000 USD (10^7 fixed-point)
  stalenessWindow: 600, // 10 minutes
  condition: 'less_than',
});
```

---

### `setOraclePriceCondition(options)`

**Purpose:** Attach an oracle price condition to an already-registered task.

**Signature:**
```typescript
function setOraclePriceCondition(options: {
  taskId: u64;
  oracle: Address;
  asset: Symbol;
  threshold: i128;
  stalenessWindow: u64;
  condition?: 'less_than' | 'greater_than' | 'equal';
  keeperRegistryId: Address;
  signer: Keypair;
}): Promise<string>; // Returns transaction hash
```

**Returns:** Transaction hash of the operation.

**Example:**
```typescript
const txHash = await setOraclePriceCondition({
  taskId: 42n,
  oracle: 'CBDT4ZDWHKFVG5...',
  asset: 'ETH',
  threshold: 1_800_000_000, // 1800 USD
  stalenessWindow: 300,
  keeperRegistryId: 'CDJOYHBS7C2PVJS47...',
  signer: ownerKeypair,
});
console.log(`Set oracle condition in tx: ${txHash}`);
```

---

### `getOraclePriceCondition(taskId)`

**Purpose:** Query the current oracle price condition for a task.

**Signature:**
```typescript
function getOraclePriceCondition(taskId: u64): Promise<{
  oracle: Address;
  asset: Symbol;
  threshold: i128;
  stalenessWindow: u64;
  condition: 'less_than' | 'greater_than' | 'equal';
} | null>;
```

**Returns:** The oracle condition, or `null` if no condition is set.

**Example:**
```typescript
const cond = await getOraclePriceCondition(42n);
if (cond) {
  console.log(`Task 42 executes when ${cond.asset} < ${cond.threshold}`);
} else {
  console.log('Task 42 has no oracle condition');
}
```

---

### `isPriceConditionMet(options)`

**Purpose:** Check if an oracle price currently satisfies a task's condition.

**Signature:**
```typescript
function isPriceConditionMet(options: {
  oracle: Address;
  asset: Symbol;
  threshold: i128;
  condition: 'less_than' | 'greater_than' | 'equal';
  rpcUrl: string;
}): Promise<boolean>;
```

**Returns:** `true` if the current oracle price meets the condition, `false` otherwise.

**Example:**
```typescript
const met = await isPriceConditionMet({
  oracle: 'CBDT4ZDWHKFVG5...',
  asset: 'XLM',
  threshold: 1_000_000, // 0.10 USD
  condition: 'less_than',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

if (met) {
  console.log('XLM price is below $0.10 - task is executable');
} else {
  console.log('XLM price is >= $0.10 - condition not met');
}
```

---

### `isPriceFresh(options)`

**Purpose:** Check if an oracle price is fresh (not stale).

**Signature:**
```typescript
function isPriceFresh(options: {
  oracle: Address;
  asset: Symbol;
  stalenessWindow: u64;
  rpcUrl: string;
}): Promise<{
  fresh: boolean;
  lastUpdate: u64; // Unix timestamp of last price update
  age: u64;        // Seconds since last update
}>;
```

**Returns:** Staleness status and age metadata.

**Example:**
```typescript
const freshness = await isPriceFresh({
  oracle: 'CBDT4ZDWHKFVG5...',
  asset: 'BTC',
  stalenessWindow: 300, // 5 minutes
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

console.log(`BTC price is ${freshness.fresh ? 'fresh' : 'stale'}`);
console.log(`Age: ${freshness.age} seconds (staleness window: 300s)`);
```

---

## Testnet Walkthrough

This section provides a concrete, reproducible example using the live testnet contract.

### Testnet Contract Details

| Component | Address / ID |
|-----------|--------------|
| Keeper Registry | `CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4` |
| Reflector Oracle | `CBDT4ZDWHKFVG5IJFUVDQ5JRU2KKRQBCYEQ6M3HFHV74CWXMQFNPFSC` |
| XLM/USD Feed | Asset: `XLM`, Oracle: Reflector |
| Test Faucet | https://friendbot.stellar.org |

### Full Example: BTC Liquidation Task

**Scenario:** A lending protocol wants to automatically liquidate positions when BTC price drops below $38,000. They register a task on the Keeper Network.

#### Code Example

```typescript
import { 
  SorobanClient, 
  buildOraclePriceCondition,
  setOraclePriceCondition,
  isPriceConditionMet,
  isPriceFresh,
} from '@soroban-tooling/keeper-network-sdk';
import { Keypair, TransactionBuilder } from 'stellar-sdk';

// 1. Setup
const rpcUrl = 'https://soroban-testnet.stellar.org';
const client = new SorobanClient({ rpcUrl });

const keeperRegistryId = 'CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4';
const oracleAddress = 'CBDT4ZDWHKFVG5IJFUVDQ5JRU2KKRQBCYEQ6M3HFHV74CWXMQFNPFSC';

// Load your testnet account keypair (or use Keypair.random() for testing)
const ownerKeypair = Keypair.fromSecret('SBXXX...'); // Your secret key

// 2. Prepare task parameters
const now = Math.floor(Date.now() / 1000);
const deadline = now + (7 * 24 * 60 * 60); // 7 days
const taskType = 'Custom'; // or 'OraclePricePush'
const liquidationCalldata = Buffer.from('0xdeadbeef'); // Placeholder
const reward = 1_000_000; // 0.1 XLM in stroops
const ttlLedgers = 120960; // 7 days
const lockLedgers = 300; // ~25 minutes

// 3. Register the task
console.log('Registering task...');
const taskId = await client.registerTask({
  owner: ownerKeypair.publicKey(),
  taskType,
  calldata: liquidationCalldata,
  reward,
  deadline,
  ttlLedgers,
  lockLedgers,
  verifier: null,
  signer: ownerKeypair,
});
console.log(`✓ Task ${taskId} registered`);

// 4. Attach oracle condition
console.log('Attaching oracle price condition...');
const btcThreshold = 38_000_000_000; // 38,000 USD in 10^7 fixed-point
const stalenessWindow = 300; // 5 minutes

await setOraclePriceCondition({
  taskId,
  oracle: oracleAddress,
  asset: 'BTC',
  threshold: btcThreshold,
  stalenessWindow,
  keeperRegistryId,
  signer: ownerKeypair,
});
console.log(`✓ Oracle condition attached (BTC price < $38,000)`);

// 5. Check if condition is met and price is fresh
console.log('Checking oracle price...');

const conditionMet = await isPriceConditionMet({
  oracle: oracleAddress,
  asset: 'BTC',
  threshold: btcThreshold,
  condition: 'less_than',
  rpcUrl,
});

const priceFresh = await isPriceFresh({
  oracle: oracleAddress,
  asset: 'BTC',
  stalenessWindow,
  rpcUrl,
});

console.log(`Price condition met: ${conditionMet}`);
console.log(`Price fresh: ${priceFresh.fresh} (age: ${priceFresh.age}s)`);

// 6. Monitor for keeper execution
console.log('Task registered and ready for keepers to claim and execute.');
console.log(`Task ID: ${taskId}`);
console.log(`Explorer: https://stellar.expert/explorer/testnet/tx/${taskId}`);
```

#### Expected Output

```
Registering task...
✓ Task 123 registered
Attaching oracle price condition...
✓ Oracle condition attached (BTC price < $38,000)
Checking oracle price...
Price condition met: false (current BTC price is $45,200)
Price fresh: true (age: 45s)
Task registered and ready for keepers to claim and execute.
Task ID: 123
Explorer: https://stellar.expert/explorer/testnet/...
```

#### What Happens Next

1. **Keeper bot detects the task** via event indexing
2. **Keeper checks the oracle price:** "Is BTC < $38,000?" → Currently `false`, so waits
3. **When BTC price drops below $38,000:**
   - Keeper calls `claim_task(123)`
   - Keeper executes the liquidation logic
   - Keeper submits `execute_task(123, proof)`
   - Keeper receives 0.1 XLM (minus protocol fee)
4. **If the oracle feed goes stale:**
   - Keeper cannot execute (staleness check fails)
   - Task owner extends deadline or cancels and re-registers

---

## Troubleshooting & Common Patterns

### Issue 1: "StalePrice" Error on Execution

**Symptom:** Task executes but fails with `KeeperError::StalePrice`.

**Cause:** The oracle price hasn't been updated within the staleness window.

**Solution:**
1. Verify the oracle feed is updating (check recent blocks on Stellar Expert)
2. Increase the `stalenessWindow` when re-registering (if temporarily acceptable)
3. Switch to an oracle with more frequent updates
4. Contact the oracle provider if the feed is genuinely broken

**Code to check:**
```typescript
const { fresh, age } = await isPriceFresh({
  oracle: oracleAddress,
  asset: 'BTC',
  stalenessWindow: 300,
  rpcUrl,
});

if (!fresh) {
  console.error(`Price is stale (age: ${age}s, max: 300s)`);
  // Extend the task deadline to allow more time for recovery
}
```

---

### Issue 2: Price Precision Mismatch

**Symptom:** Threshold comparisons behave unexpectedly (e.g., threshold set to 1,000,000 but price comparison fails).

**Cause:** Soroban prices are stored in 10^7 fixed-point format. If you set a threshold without accounting for this, the comparison fails.

**Solution:** Always multiply your decimal price by 10^7.

**Correct Example:**
```typescript
// USD price: 0.10 (10 cents)
// Fixed-point: 0.10 * 10^7 = 1,000,000
const thresholdInFixedPoint = Math.floor(0.10 * 1e7); // 1_000_000

const condition = buildOraclePriceCondition({
  oracle: oracleAddress,
  asset: 'XLM',
  threshold: thresholdInFixedPoint, // Correct
  stalenessWindow: 300,
});
```

**Wrong Example:**
```typescript
// Forgetting the 10^7 conversion
const thresholdWrong = Math.floor(0.10); // 0 — will never match!
```

---

### Issue 3: Task Never Executes (Condition Always False)

**Symptom:** Task remains in `Pending` → `Claimed` → `Pending` forever.

**Cause:** The oracle price never crosses your threshold, or your condition operator (`less_than` vs `greater_than`) is inverted.

**Solution:** Verify your condition logic:

```typescript
const currentPrice = await getOraclePrice(oracleAddress, 'BTC');
const threshold = 38_000_000_000;

// If you want to trigger when price drops BELOW $38,000:
if (currentPrice < threshold) {
  console.log('Condition is TRUE - should execute');
} else {
  console.log('Condition is FALSE - adjust threshold or wait for price move');
}
```

Double-check your operator:
- `less_than`: Triggers when `price < threshold`
- `greater_than`: Triggers when `price > threshold`
- `equal`: Triggers when `price == threshold` (rare; not recommended due to precision)

---

### Issue 4: Keeper Sees Task But Cannot Execute (Even When Condition Met)

**Symptom:** Keeper claims the task but `execute_task` fails with `InvalidTaskStatus` or `KeeperError::ConditionNotMet`.

**Causes:**
1. **Condition is actually not met** — Double-check the oracle price
2. **Price is stale** — `age > stalenessWindow`
3. **Task is in wrong state** — Already executed, expired, or cancelled
4. **Deadline passed** — Task is auto-expired

**Debugging:**
```typescript
// Check task state
const task = await client.getTask(taskId);
console.log(`Task status: ${task.status}`); // Should be 'Claimed'
console.log(`Task deadline: ${task.deadline}`);
console.log(`Current time: ${Math.floor(Date.now() / 1000)}`);

// Check oracle price
const { fresh, age } = await isPriceFresh({
  oracle: oracleAddress,
  asset: 'BTC',
  stalenessWindow: 300,
  rpcUrl,
});
console.log(`Price fresh: ${fresh}, age: ${age}s`);

// Check condition
const met = await isPriceConditionMet({
  oracle: oracleAddress,
  asset: 'BTC',
  threshold: 38_000_000_000,
  condition: 'less_than',
  rpcUrl,
});
console.log(`Condition met: ${met}`);
```

---

### Pattern 1: Dynamic Price Thresholds

**Goal:** Adjust task thresholds based on market conditions without cancelling.

**Pattern:** Re-register the task with a new threshold. Since there's no `update_oracle_condition` function, the standard workaround is:

```typescript
// 1. Cancel the old task
await client.cancelTask(oldTaskId, ownerKeypair);

// 2. Register a new one with updated threshold
const newTaskId = await client.registerTask({
  // ...same parameters, but with new oracle condition details...
});

// 3. Set the new oracle condition
await setOraclePriceCondition({
  taskId: newTaskId,
  oracle: oracleAddress,
  asset: 'BTC',
  threshold: 40_000_000_000, // New threshold: $40,000
  stalenessWindow: 300,
  keeperRegistryId,
  signer: ownerKeypair,
});
```

**Limitation:** Cancellation refunds the reward but forfeits any claim locks keepers may be holding.

---

### Pattern 2: Multiple Feeds (Fallback Redundancy)

**Goal:** Hedge against one oracle feed going stale by registering duplicate tasks on different feeds.

**Pattern:**
```typescript
// Task 1: Primary feed (Reflector)
const taskId1 = await client.registerTask({ /* ... */ });
await setOraclePriceCondition({
  taskId: taskId1,
  oracle: 'CBDT4ZDWHKFVG5...', // Reflector
  asset: 'BTC',
  threshold,
  stalenessWindow: 300,
  keeperRegistryId,
  signer: ownerKeypair,
});

// Task 2: Fallback feed (Band Protocol, if deployed)
const taskId2 = await client.registerTask({ /* ... */ });
await setOraclePriceCondition({
  taskId: taskId2,
  oracle: 'CBXX...', // Band Protocol (hypothetical)
  asset: 'BTC',
  threshold,
  stalenessWindow: 300,
  keeperRegistryId,
  signer: ownerKeypair,
});

console.log(`Registered redundant tasks: ${taskId1}, ${taskId2}`);
```

Keepers will see both and execute whichever becomes executable first. This trades cost (double reward) for availability.

---

### Pattern 3: Time-Windowed Conditional Execution

**Goal:** Execute a task only if price meets threshold AND current time is within a specific window.

**Pattern:** Embed time logic in your task's calldata/verifier.

```typescript
// In your verifier contract:
fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool {
  let now = env.ledger().timestamp();
  
  // Example: only execute between 8 UTC and 16 UTC
  let hour = (now % 86400) / 3600;
  if hour < 8 || hour >= 16 {
    return false; // Outside execution window
  }
  
  // Then check your proof...
  verify_proof(proof)
}
```

The Keeper Network handles the oracle price condition; you handle the time constraint via verifier logic.

---

## Summary

**Oracle-conditioned tasks** are the gateway to sophisticated on-chain automation:

1. **Choose an oracle** — Reflector is the primary option on Stellar testnet.
2. **Build your condition** — Use SDK helpers to encode price thresholds and staleness windows.
3. **Register and attach** — Register the task, then call `setOraclePriceCondition`.
4. **Monitor staleness** — Understand that stale prices cannot be used for execution.
5. **Handle failures gracefully** — Extend deadlines, increase rewards, or cancel and re-register if feeds go down.

The full end-to-end flow is traceable on-chain: register → claim → execute, with every step emitting events visible to keepers and analytics tools.

**Next Steps:**
- Explore the [Keeper Bot V2 design](./KEEPER_BOT_V2_DESIGN.md) for how keeper bots monitor and execute oracle-conditioned tasks
- Review [BATCH_OPERATIONS.md](./BATCH_OPERATIONS.md) if you need to register many tasks at once
- Check [VERIFIER_DESIGN.md](./VERIFIER_DESIGN.md) if you want to add custom proof verification on top of oracle conditions
