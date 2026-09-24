# Keeper Bot Dry-Run Mode

## Overview

Dry-run mode executes the complete keeper evaluation pipeline **without submitting any transactions**. All decisions—claims and skips—are logged in structured JSON-per-line format that operators can compare across runs, configurations, and chain states.

This is useful for:
- **Testing configurations** against live chain state without risking transactions
- **Comparing profitability logic** under different margin thresholds
- **Debugging decision logic** to understand why tasks are or aren't being claimed
- **A/B testing** keeper parameters before deploying live
- **Auditing** what the keeper would have done in the past

## Quick Start

### 1. Enable Dry-Run Mode

Set the environment variable:

```bash
DRY_RUN=true node index.js
```

Or in `.env`:

```
DRY_RUN=true
REGISTRY_CONTRACT_ID=CXXXXXXX...
NETWORK=testnet
```

**Note**: In dry-run mode, `KEEPER_SECRET_KEY` is **optional**. If not provided, the bot generates a temporary keypair for address operations. No transactions are ever signed or submitted.

### 2. Inspect Decision Output

Each decision is output as one JSON record per line:

```bash
$ DRY_RUN=true REGISTRY_CONTRACT_ID=C... NETWORK=testnet node index.js --once 2>/dev/null | grep '^\{'
{"timestamp":"2024-01-15T10:23:45.123Z","taskId":123,"decision":"skip","reason":"Task is past deadline","evaluationPhase":1,"taskMetadata":{"deadline":1705328400}}
{"timestamp":"2024-01-15T10:23:46.456Z","taskId":124,"decision":"claim","reason":"Task passed all profitability and eligibility checks (est net profit: 900000 stroops)","taskMetadata":{"taskType":"TtlExtension","deadline":1705328450},"profitability":{"reward":"1000000","estimatedFee":"100000","netProfit":"900000","profitable":true,"profitMargin":"0"}}
```

### 3. Compare Across Runs

Use `jq` or similar tools to diff decision outputs:

```bash
# Capture decisions from two different configurations
DRY_RUN=true MIN_PROFIT_MARGIN_STROOPS=100000 node index.js --once 2>/dev/null | jq '.taskId, .decision' > /tmp/config-a.txt

DRY_RUN=true MIN_PROFIT_MARGIN_STROOPS=500000 node index.js --once 2>/dev/null | jq '.taskId, .decision' > /tmp/config-b.txt

# Compare
diff /tmp/config-a.txt /tmp/config-b.txt
```

## Decision Record Schema

Each output record is a JSON object with the following fields:

### Common Fields (All Decisions)

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 timestamp when the decision was made |
| `taskId` | number | Task ID |
| `decision` | string | `"claim"` or `"skip"` |
| `reason` | string | Human-readable explanation of the decision |

### Skip-Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `evaluationPhase` | number | Which phase caused the skip: 1=deadline, 2=verifier_support, 3=proof_generation, 4=profitability |
| `taskMetadata` | object | Task details (see below) |
| `profitability` | object | (Optional) Profitability evaluation if phase=4 |

### Claim-Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `taskMetadata` | object | Task details (see below) |
| `profitability` | object | Profitability evaluation results |

### Task Metadata (`taskMetadata`)

| Field | Type | Description |
|-------|------|-------------|
| `taskType` | string | Task type name (e.g., `"TtlExtension"`, `"Liquidation"`) |
| `verifier` | string | (Optional) Verifier contract ID if the task has one attached |
| `deadline` | number | Task deadline (seconds since epoch) |

### Profitability Object (`profitability`)

| Field | Type | Description |
|-------|------|-------------|
| `reward` | string | Task reward in stroops (string to preserve precision) |
| `estimatedFee` | string | Estimated total fees (claim + execute + verifier) in stroops |
| `netProfit` | string | Net profit after fees in stroops |
| `profitable` | boolean | Whether the task meets the profitability threshold |
| `profitMargin` | string | Configured minimum profit margin in stroops |

## Skip Reasons by Phase

### Phase 1: Deadline Check
```
"Task is past deadline"
```

### Phase 2: Verifier/Executor Support
```
"Unsupported verifier/executor — no executor registered for task type Liquidation"
"Unsupported verifier/executor — unrecognized verifier contract C... (no proof-generation strategy registered)"
```

### Phase 3: Proof Generation
```
"Could not generate valid proof for TtlExtension"
```

### Phase 4: Profitability
```
"net profit (900000 stroops) below minimum margin (1000000 stroops; estimated gas: 100000 stroops, reward: 1000000 stroops)"
```

## Use Cases

### Example 1: Test a New Profit Margin

Before deploying a new margin in production, test it against the current chain state:

```bash
DRY_RUN=true MIN_PROFIT_MARGIN_STROOPS=500000 REGISTRY_CONTRACT_ID=C... NETWORK=testnet node index.js --once 2>/dev/null | jq 'select(.evaluationPhase==4) | {taskId, reason, profitability}'
```

This shows exactly which tasks would be skipped due to profitability under the new margin.

### Example 2: Audit Historical Decisions

With live-mode logs stored, compare what the keeper would do now vs. what it did then:

```bash
# Get current decisions
DRY_RUN=true ... node index.js --once > current.ndjson

# Compare with archived logs
diff <(jq '.taskId' current.ndjson) <(jq '.taskId' archived.ndjson)
```

### Example 3: Debug Task Processing

When a task isn't being claimed as expected, dry-run reveals exactly where it's being filtered:

```bash
DRY_RUN=true ... node index.js --once 2>/dev/null | jq "select(.taskId==12345)"
# Output shows which phase caused the skip and why
```

### Example 4: Test Multiple Configurations Quickly

Compare how different executor strategies would affect decisions:

```bash
for margin in 0 100000 500000 1000000; do
  echo "=== Margin: $margin ==="
  DRY_RUN=true MIN_PROFIT_MARGIN_STROOPS=$margin ... node index.js --once 2>/dev/null | jq '.taskId, .decision' | sort
done
```

## Guarantees

1. **Decisions match live mode**: Given identical chain state and configuration, dry-run makes the same decisions as live mode. No transactions are submitted, so there's no state mutation to change the decision logic.

2. **No transactions signed or submitted**: Dry-run never calls `claim_task`, `execute_task`, or `withdraw_rewards` on-chain. All evaluation is local or via read-only RPC calls.

3. **No signing key required**: You can run dry-run without a `KEEPER_SECRET_KEY`. The bot generates a temporary keypair internally for address operations.

4. **Structured, machine-readable output**: Each decision is valid JSON on a single line, sortable and comparable with standard tools.

5. **All skip reasons captured**: Every reason a task is skipped—deadline, lack of executor, unprofitability, etc.—is recorded with enough context to understand the decision.

## Implementation Details

### Decision/Execution Boundary

Dry-run code runs the full decision pipeline:

1. **Fetch pending tasks** from event stream
2. **Check deadline** — skip if past
3. **Fetch full task details** — task type, calldata, verifier
4. **Check verifier support** — skip if no executor or verifier strategy registered
5. **Generate proof** — off-chain execution; skip if proof generation fails
6. **Check profitability** — skip if reward < fees + margin
7. **Log claim decision** — task would be claimed

In dry-run mode, step 7 logs the decision to JSON instead of actually calling `claim_task` and `execute_task`.

### Output Format

Decisions are logged via `console.log(JSON.stringify(...))`, one record per line. This format is:
- **NDJSON** (newline-delimited JSON), parseable by `jq`, `jl`, and log ingestion tools
- **Sortable**: `sort`, `uniq`, `diff` work natively
- **Machine-readable**: Every field is structured, not free text
- **Lossless**: Profitability and task metadata are preserved for comparison

### Configuration Isolation

Dry-run mode is a runtime flag, not a separate build or execution path. The same keeper-bot binary serves both:

```bash
# Live mode: transactions submitted
node index.js

# Dry-run mode: decisions logged, no transactions
DRY_RUN=true node index.js
```

## Logging

In dry-run mode, the startup banner displays:

```
  Mode     : DRY-RUN (decisions logged, no transactions submitted)
```

All standard logs (task discovery, skip reasons, decision flow) are still printed to stderr/stdout alongside the structured JSON decisions. You can suppress them:

```bash
DRY_RUN=true ... node index.js --once 2>/dev/null | grep '^\{'
```

## Limitations

1. **No state mutation**: Dry-run cannot verify that a claim would succeed (e.g., if another keeper claimed it first). It only verifies that the decision logic would attempt the claim.

2. **No verifier/executor feedback**: If a verifier or executor is called, its result is evaluated. If it throws, dry-run records the skip. But dry-run doesn't know if a verifier strategy could be registered dynamically at runtime.

3. **Approximate fee estimation**: Verifier fees are estimated via RPC simulation if available, but actual fees depend on network load and resource usage at submission time. Dry-run shows an estimate.

## Testing

Dry-run mode includes comprehensive tests:

```bash
npm test -- test/dryrun.test.js
```

Tests verify:
- Decision record creation and serialization
- JSON output is valid and parseable
- All skip phases are recorded correctly
- Claim decisions include profitability context
- Records can be compared for determinism

## See Also

- [Dry-run Issue #392](https://github.com/soroban-tooling/soroban-keeper-network/issues/392)
- [Profitability Logic #0254](https://github.com/soroban-tooling/soroban-keeper-network/.github/backlog/issues/0254-fee-bps-default-mismatch.md)
- [Task Prioritization #0261](https://github.com/soroban-tooling/soroban-keeper-network/.github/backlog/issues/0261-*)
