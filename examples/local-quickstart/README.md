# One-Command Local Network Quickstart

This example provides a single-command quickstart that provisions a local Soroban standalone network, deploys the Keeper Registry and a mock reward token, registers a demo automation task, and executes a keeper bot against it end-to-end.

---

## Acceptance Criteria

- [x] **One command reaches a state where the bot executes the demo task.**
- [x] **The script prints every contract ID and is safe to re-run.**

---

## 1. Quick Start

Run the quickstart using npm or bash:

```bash
# Using npm
npm start

# Or using bash directly
./quickstart.sh
```

### Sample Output

```text
=== Launching Soroban Keeper Network Quickstart ===
=== Soroban Keeper Network: Local Network Quickstart ===
[1/5] Checking local environment & standalone network...
  Network RPC: http://localhost:8000/soroban/rpc
  Admin account:  GB24ZVDX4IAKY53EJCM2PZW4OKQWKFOO4WXABRN2VPBP5BOSQK5U53DM
  Keeper account: GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
[2/5] Deploying core protocol contracts...

================ CONTRACT IDENTIFIERS ===============
  REWARD_TOKEN_ID:    CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
  REGISTRY_ID:        CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4
  DEMO_TARGET_ID:     CCDEMOTARGETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
=====================================================

[3/5] Registering demo automation task #1...
  Target:   CCDEMOTARGETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  Function: perform_maintenance
  Reward:   1.0000 XLM (10000000 Stroops)
  Deadline: Ledger 500
[4/5] Running keeper bot against registered demo task...
  Bot discovered pending task #1
  Simulating execution on-chain: [✔ PASS (status: SUCCESS)]
  Keeper submitting claim: task #1 locked by GD7DLCT74C2BM2J3CPWVIBK6TCRSIV5OEY56KBJ5P4TM7HEMCCOSW46K
[5/5] Executing task & settling rewards...
  Transaction confirmed in ledger!
  State transition: PENDING -> CLAIMED -> EXECUTED
  Reward credited to keeper: 0.97 XLM
  Protocol fee retained:     0.03 XLM

✔ Quickstart completed successfully! Demo task executed.
```

---

## 2. Safe Re-Run Guarantee

The script persists deployed contract identifiers to `.local-quickstart-state.json`. When invoked again:
- Existing deployed contracts are detected and reused without redeploying.
- Contract IDs are printed again.
- A fresh demo task (#2, #3, ...) is registered and executed by the bot.
- No port, contract, or state collisions occur.

---

## 3. Running the Verification Tests

```bash
npm test
```
