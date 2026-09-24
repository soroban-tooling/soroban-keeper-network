# Dry-Run Mode Examples

This document provides practical examples of using dry-run mode for common tasks.

## Basic Usage

### 1. Run a Single Dry-Run Round

```bash
DRY_RUN=true REGISTRY_CONTRACT_ID=C... NETWORK=testnet node index.js --once
```

Output:
```
Soroban Keeper Network — Keeper Bot v0.1.0

  Network  : testnet
  RPC URL  : https://soroban-testnet.stellar.org
  Keeper   : GXXXXXXXXX...
  Registry : CXXXXXXXXX...
  Mode     : DRY-RUN (decisions logged, no transactions submitted)
  Withdraw : when balance ≥ 10000000 stroops

RPC healthy — ledger 12345

Keeper round (DRY-RUN mode) at 2024-01-15T10:23:45.123Z
  Found 5 TaskRegistered events to evaluate
  [decision records output as JSON-per-line]
  ...
```

### 2. Capture Decisions to File

```bash
DRY_RUN=true REGISTRY_CONTRACT_ID=C... NETWORK=testnet node index.js --once 2>/dev/null | grep '^\{' > decisions.ndjson
```

Now each line of `decisions.ndjson` is a JSON decision record.

## Analysis Examples

### Example 1: Count Claims vs Skips

```bash
# Count total decisions
jq '.decision' decisions.ndjson | sort | uniq -c

# Output example:
#      3 "claim"
#      7 "skip"
```

### Example 2: Find Why Tasks Were Skipped

```bash
# Show all skips with their reasons, grouped by evaluation phase
jq 'select(.decision=="skip") | {phase: .evaluationPhase, reason: .reason}' decisions.ndjson
```

Output:
```json
{"phase":1,"reason":"Task is past deadline"}
{"phase":2,"reason":"Unsupported verifier/executor — no executor registered for task type Liquidation"}
{"phase":4,"reason":"net profit (45000 stroops) below minimum margin (100000 stroops; estimated gas: 150000 stroops, reward: 195000 stroops)"}
```

### Example 3: Analyze Profitability Skips

```bash
# Show profitability information for tasks that would have been claimed if margin was lower
jq 'select(.evaluationPhase==4) | {taskId, netProfit: .profitability.netProfit, margin: .profitability.profitMargin}' decisions.ndjson | jq -s 'sort_by(.netProfit)'
```

This helps identify which tasks are on the profitability boundary and might be claimable with a lower margin.

## Configuration Comparison

### Example 4: A/B Test Profitability Margins

Test how a new margin threshold would change keeper behavior:

```bash
# Save decisions with current margin
DRY_RUN=true \
  MIN_PROFIT_MARGIN_STROOPS=100000 \
  REGISTRY_CONTRACT_ID=C... \
  NETWORK=testnet \
  node index.js --once 2>/dev/null | grep '^\{' > margin-100k.ndjson

# Save decisions with new margin
DRY_RUN=true \
  MIN_PROFIT_MARGIN_STROOPS=500000 \
  REGISTRY_CONTRACT_ID=C... \
  NETWORK=testnet \
  node index.js --once 2>/dev/null | grep '^\{' > margin-500k.ndjson

# Compare which tasks changed decision
echo "Tasks claimed in both:"
comm -12 \
  <(jq -r 'select(.decision=="claim") | .taskId' margin-100k.ndjson | sort) \
  <(jq -r 'select(.decision=="claim") | .taskId' margin-500k.ndjson | sort)

echo ""
echo "Tasks claimed at 100k margin only:"
comm -23 \
  <(jq -r 'select(.decision=="claim") | .taskId' margin-100k.ndjson | sort) \
  <(jq -r 'select(.decision=="claim") | .taskId' margin-500k.ndjson | sort)
```

This shows exactly which tasks would no longer be claimed with the new margin.

### Example 5: Compare Different Task Type Support

```bash
# Test with different executor configurations
# (Would require modifying EXECUTORS in index.js for real test)

# Get decision summary
jq '.decision' decisions.ndjson | sort | uniq -c
```

## Debugging Examples

### Example 6: Debug a Specific Task

When a task isn't being claimed as expected:

```bash
# Find the specific task
jq "select(.taskId==12345)" decisions.ndjson | jq .

# Output example:
{
  "timestamp": "2024-01-15T10:23:47.890Z",
  "taskId": 12345,
  "decision": "skip",
  "reason": "net profit (80000 stroops) below minimum margin (100000 stroops; estimated gas: 150000 stroops, reward: 230000 stroops)",
  "evaluationPhase": 4,
  "taskMetadata": {
    "taskType": "TtlExtension",
    "deadline": 1705328400
  },
  "profitability": {
    "reward": "230000",
    "estimatedFee": "150000",
    "netProfit": "80000",
    "profitable": false,
    "profitMargin": "100000"
  }
}
```

This clearly shows:
- The task was skipped due to profitability (phase 4)
- Reward is 230k stroops
- Estimated fees are 150k stroops
- Net profit would be 80k stroops
- But configured margin requires at least 100k stroops
- Task would be claimed if margin were ≤80k

### Example 7: Find Unsupported Tasks

```bash
# Show all tasks skipped due to lack of executor/verifier
jq 'select(.evaluationPhase==2) | {taskId, reason: .reason, taskType: .taskMetadata.taskType}' decisions.ndjson

# Output example:
{"taskId":5001,"reason":"Unsupported verifier/executor — no executor registered for task type Liquidation","taskType":"Liquidation"}
{"taskId":5002,"reason":"Unsupported verifier/executor — unrecognized verifier contract CDXXX... (no proof-generation strategy registered)","taskType":"Custom"}
```

This helps identify which task types or verifiers need executor/strategy implementations.

## Monitoring Examples

### Example 8: Track Decision Trends Over Time

```bash
# Run dry-run every 5 minutes and log results
for i in {1..12}; do
  DRY_RUN=true REGISTRY_CONTRACT_ID=C... NETWORK=testnet node index.js --once 2>/dev/null | grep '^\{' >> decisions-$(date +%Y%m%d).log
  sleep 300
done

# Analyze trends
echo "Tasks processed per round:"
jq '.taskId' decisions-*.log | wc -l

echo "Claims per round:"
jq 'select(.decision=="claim")' decisions-*.log | jq -s 'group_by(input_filename)' | jq '.[] | length'
```

### Example 9: Generate a Summary Report

```bash
jq -s '{
  total_decisions: length,
  claims: [.[] | select(.decision=="claim")] | length,
  skips: [.[] | select(.decision=="skip")] | length,
  by_phase: [.[] | select(.decision=="skip") | .evaluationPhase] | group_by(.) | map({phase: .[0], count: length}),
  avg_profitability: [.[] | select(.evaluationPhase==4) | (.profitability.netProfit | tonumber)] | add / length
}' decisions.ndjson
```

Output example:
```json
{
  "total_decisions": 10,
  "claims": 3,
  "skips": 7,
  "by_phase": [
    {"phase": 1, "count": 2},
    {"phase": 2, "count": 3},
    {"phase": 4, "count": 2}
  ],
  "avg_profitability": 125000
}
```

## Advanced Examples

### Example 10: Compare Two Keeper Configurations

```bash
# Config 1: Conservative (high margin, low throughput)
DRY_RUN=true \
  MIN_PROFIT_MARGIN_STROOPS=1000000 \
  MAX_TASKS_PER_ROUND=3 \
  REGISTRY_CONTRACT_ID=C... \
  node index.js --once 2>/dev/null | grep '^\{' > config-conservative.ndjson

# Config 2: Aggressive (low margin, high throughput)
DRY_RUN=true \
  MIN_PROFIT_MARGIN_STROOPS=100000 \
  MAX_TASKS_PER_ROUND=10 \
  REGISTRY_CONTRACT_ID=C... \
  node index.js --once 2>/dev/null | grep '^\{' > config-aggressive.ndjson

# Compare claim sets
echo "Tasks claimed only in conservative config:"
comm -23 \
  <(jq -r 'select(.decision=="claim") | .taskId' config-conservative.ndjson | sort) \
  <(jq -r 'select(.decision=="claim") | .taskId' config-aggressive.ndjson | sort)

echo ""
echo "Tasks claimed only in aggressive config:"
comm -13 \
  <(jq -r 'select(.decision=="claim") | .taskId' config-conservative.ndjson | sort) \
  <(jq -r 'select(.decision=="claim") | .taskId' config-aggressive.ndjson | sort)

# Analyze profitability distribution
echo ""
echo "Average net profit (conservative):"
jq -r 'select(.decision=="claim") | .profitability.netProfit' config-conservative.ndjson | \
  jq -s 'map(tonumber) | add / length'

echo "Average net profit (aggressive):"
jq -r 'select(.decision=="claim") | .profitability.netProfit' config-aggressive.ndjson | \
  jq -s 'map(tonumber) | add / length'
```

### Example 11: Export to CSV for Spreadsheet Analysis

```bash
# Create CSV header
echo "timestamp,taskId,decision,phase,reason,netProfit,profitable" > decisions.csv

# Convert JSON to CSV
jq -r '[.timestamp, .taskId, .decision, .evaluationPhase // "N/A", .reason, (.profitability.netProfit // "N/A"), (.profitability.profitable // "N/A")] | @csv' decisions.ndjson >> decisions.csv

# Now open in Excel, Google Sheets, or analyze with Python
```

## Tips & Tricks

### Use jq for Complex Queries

```bash
# Find the most profitable claimable task
jq -s 'map(select(.decision=="claim")) | sort_by(.profitability.netProfit | tonumber) | reverse[0]' decisions.ndjson

# Find tasks with the largest gap to profitability threshold
jq -s 'map(select(.evaluationPhase==4)) | sort_by((.profitability.profitMargin | tonumber) - (.profitability.netProfit | tonumber)) | reverse[0:5]' decisions.ndjson
```

### Suppress Console Output

To see only the JSON records:

```bash
DRY_RUN=true REGISTRY_CONTRACT_ID=C... node index.js --once 2>/dev/null | grep '^\{'
```

The `2>/dev/null` redirects stderr to /dev/null, suppressing log output. The `grep` filter shows only JSON lines.

### Combine with Streaming Tools

Use `jq --stream` for memory-efficient processing of large files:

```bash
cat decisions.ndjson | jq -s 'group_by(.decision) | map({decision: .[0].decision, count: length})' 
```

### Create Alerts

Alert when specific conditions are met:

```bash
# Alert if too many skips due to profitability
jq -r 'select(.evaluationPhase==4)' decisions.ndjson | wc -l | awk '$1 > 3 {print "WARNING: Too many profitability skips"}' 
```

## See Also

- [DRY_RUN.md](./DRY_RUN.md) - Complete dry-run mode documentation
- [README.md](../../../README.md) - Keeper network overview
- [jq Manual](https://stedolan.github.io/jq/manual/) - JSON query language reference
