# Emergency Pause Drill — November 20, 2026

## Objective

Execute the incident response plan's pause path on testnet to verify:
1. Pause mechanism triggers correctly
2. All components react as documented in `docs/INCIDENT_RESPONSE.md`
3. All blocked operations fail with expected error
4. All allowed operations succeed
5. Unpause restores normal operation

## Pre-Drill Setup

### Environment
- **Network:** Stellar testnet
- **Contract:** KeeperRegistry (contract ID: `CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`)
- **Treasury:** KeeperTreasury (contract ID: `TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT`)
- **Indexer:** Running on testnet RPC endpoint
- **Keeper bot:** v2 instance monitoring the contract
- **Monitoring:** Grafana dashboards and alerting enabled

### Pre-Drill State
- [ ] Contract initialized and not paused
- [ ] At least 5 tasks in PENDING state
- [ ] At least 2 tasks in CLAIMED state
- [ ] Keeper account with non-zero balance
- [ ] At least 1 keeper with staked reputation
- [ ] Indexer fully synced (< 1 ledger lag)
- [ ] Keeper bot running and healthy

### Participants
- Ops engineer (primary keyholder)
- Backup ops engineer (secondary keyholder)
- Security engineer
- Protocol engineer (contract verification)
- DevOps/SRE (monitoring)
- Scribe (logging observations)

---

## Drill Execution

### Phase 1: Verification (T+0 min)

**Goal:** Confirm pre-drill state and establish baseline.

#### Step 1.1: Verify contract is not paused
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $ADMIN_KEY \
  --network testnet \
  -- is_paused
```

**Expected output:** `false`

**Actual output:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 1.2: Verify indexer is synced
```bash
curl -s https://testnet-indexer.example.com/api/health | jq '.lag_ms'
```

**Expected output:** < 5000 (< 5 seconds lag)

**Actual output:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 1.3: Verify keeper bot is running
```bash
curl -s http://localhost:3000/health
```

**Expected output:** `{"status":"healthy"}`

**Actual output:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 1.4: List existing tasks
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $ADMIN_KEY \
  --network testnet \
  -- task_count
```

**Count of tasks:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

---

### Phase 2: Pause Execution (T+5 min)

**Goal:** Execute pause and verify all components detect it.

#### Step 2.1: Call pause()
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $ADMIN_KEY \
  --network testnet \
  -- pause \
  --admin $ADMIN_ADDRESS
```

**Transaction hash:** _____________________

**Expected outcome:** Transaction succeeds, `paused` event emitted

**Actual outcome:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

**Observations:**
- Network latency: _____ seconds
- Ledger number: _____
- Memo field (if any): _____________________

#### Step 2.2: Verify pause took effect via view
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $ADMIN_KEY \
  --network testnet \
  -- is_paused
```

**Expected output:** `true`

**Actual output:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 2.3: Verify pause event was emitted
Query the indexer for the pause event:

```bash
curl -s "https://testnet-indexer.example.com/api/events" \
  -H "Content-Type: application/json" \
  -d '{"topics":["paused"],"limit":1}' | jq '.[0]'
```

**Expected output:** Event with `paused=true`

**Actual output:** _____________________

**Event timestamp (UTC):** _____________________

**Ledger confirmed in:** _____ ledgers (should be ≤ 3)

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 2.4: Verify keeper bot detects pause
Check the bot's logs:

```bash
tail -50 /var/log/keeper-bot.log | grep -i "paused\|emergency"
```

**Expected:** Bot log contains message about contract being paused

**Actual output:** _____________________

**Did bot stop claiming new tasks?** ☐ Yes ☐ No

**Did bot still try to execute existing claims?** ☐ Yes ☐ No

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

---

### Phase 3: Blocked Operations (T+10 min)

**Goal:** Verify that operations that should be blocked are rejected with appropriate errors.

#### Step 3.1: Attempt register_task (should fail)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $OWNER_KEY \
  --network testnet \
  -- register_task \
  --owner $OWNER_ADDRESS \
  --task_type "Liquidation" \
  --calldata "0x1234..." \
  --reward 1000000 \
  --deadline $FUTURE_TIMESTAMP \
  --ttl_ledgers 17280 \
  --lock_ledgers 120
```

**Expected:** Transaction fails with error "ContractPaused" or "Paused"

**Actual error:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 3.2: Attempt claim_task (should fail)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $KEEPER_KEY \
  --network testnet \
  -- claim_task \
  --keeper $KEEPER_ADDRESS \
  --task_id 1
```

**Expected:** Transaction fails with error "ContractPaused" or "Paused"

**Actual error:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 3.3: Attempt execute_task (should fail)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $KEEPER_KEY \
  --network testnet \
  -- execute_task \
  --keeper $KEEPER_ADDRESS \
  --task_id 1 \
  --proof "0xabcd..."
```

**Expected:** Transaction fails with error "ContractPaused" or "Paused"

**Actual error:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 3.4: Attempt increase_reward (should fail)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $OWNER_KEY \
  --network testnet \
  -- increase_reward \
  --owner $OWNER_ADDRESS \
  --task_id 1 \
  --amount 500000
```

**Expected:** Transaction fails with error "ContractPaused" or "Paused"

**Actual error:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 3.5: Attempt extend_deadline (should fail)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $OWNER_KEY \
  --network testnet \
  -- extend_deadline \
  --owner $OWNER_ADDRESS \
  --task_id 1 \
  --new_deadline $FUTURE_TIMESTAMP
```

**Expected:** Transaction fails with error "ContractPaused" or "Paused"

**Actual error:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 3.6: Attempt stake_deposit (should fail)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $KEEPER_KEY \
  --network testnet \
  -- stake_deposit \
  --keeper $KEEPER_ADDRESS \
  --amount 1000000
```

**Expected:** Transaction fails with error "ContractPaused" or "Paused"

**Actual error:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

**Summary of Blocked Operations:**
- All 6 operations blocked as expected? ☐ Yes ☐ No
- Error codes consistent? ☐ Yes ☐ No
- Errors user-friendly? ☐ Yes ☐ No

---

### Phase 4: Allowed Operations (T+20 min)

**Goal:** Verify that operations that should remain available during pause work correctly.

#### Step 4.1: Attempt cancel_task (should succeed)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $OWNER_KEY \
  --network testnet \
  -- cancel_task \
  --owner $OWNER_ADDRESS \
  --task_id 2
```

**Expected:** Transaction succeeds

**Actual outcome:** _____________________

**TX hash:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 4.2: Attempt expire_task (should succeed)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $CALLER_KEY \
  --network testnet \
  -- expire_task \
  --task_id 3
```

**Expected:** Transaction succeeds (permissionless)

**Actual outcome:** _____________________

**TX hash:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 4.3: Attempt withdraw_rewards (should succeed)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $KEEPER_KEY \
  --network testnet \
  -- withdraw_rewards \
  --keeper $KEEPER_ADDRESS
```

**Expected:** Transaction succeeds (keeper fund recovery)

**Actual outcome:** _____________________

**TX hash:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 4.4: Attempt withdraw_stake (should succeed)
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $KEEPER_KEY \
  --network testnet \
  -- withdraw_stake \
  --keeper $KEEPER_ADDRESS
```

**Expected:** Transaction succeeds (keeper stake return)

**Actual outcome:** _____________________

**TX hash:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 4.5: Verify views work (should all succeed)
```bash
# All views should return data normally
stellar contract invoke --id $CONTRACT --source $ADMIN --network testnet -- get_task --task_id 1
stellar contract invoke --id $CONTRACT --source $ADMIN --network testnet -- task_count
stellar contract invoke --id $CONTRACT --source $ADMIN --network testnet -- keeper_balance --keeper $KEEPER_ADDRESS
stellar contract invoke --id $CONTRACT --source $ADMIN --network testnet -- fees_accrued
```

**All views returned data?** ☐ Yes ☐ No

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

**Summary of Allowed Operations:**
- All 5 operations allowed as expected? ☐ Yes ☐ No
- Fund recovery paths work? ☐ Yes ☐ No
- Views are responsive? ☐ Yes ☐ No

---

### Phase 5: Unpause (T+30 min)

**Goal:** Resume normal operation and verify recovery.

#### Step 5.1: Call unpause()
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $ADMIN_KEY \
  --network testnet \
  -- unpause \
  --admin $ADMIN_ADDRESS
```

**Transaction hash:** _____________________

**Expected outcome:** Transaction succeeds, `paused` event emitted with `paused=false`

**Actual outcome:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

**Observations:**
- Network latency: _____ seconds
- Ledger number: _____

#### Step 5.2: Verify unpause took effect via view
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $ADMIN_KEY \
  --network testnet \
  -- is_paused
```

**Expected output:** `false`

**Actual output:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 5.3: Verify previously-blocked operations now work
```bash
stellar contract invoke \
  --id CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC \
  --source $OWNER_KEY \
  --network testnet \
  -- register_task \
  --owner $OWNER_ADDRESS \
  --task_type "Liquidation" \
  --calldata "0x1234..." \
  --reward 1000000 \
  --deadline $FUTURE_TIMESTAMP \
  --ttl_ledgers 17280 \
  --lock_ledgers 120
```

**Expected:** Transaction succeeds (new task can be registered)

**Actual outcome:** _____________________

**New task ID:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 5.4: Verify keeper bot resumed operation
Check bot logs:

```bash
tail -50 /var/log/keeper-bot.log | grep -i "resumed\|operation\|claim"
```

**Expected:** Bot resumed claiming and attempting to execute

**Actual output:** _____________________

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

#### Step 5.5: Verify indexer is still synced
```bash
curl -s https://testnet-indexer.example.com/api/health | jq '.lag_ms'
```

**Expected output:** < 5000

**Actual output:** _____________________

**Backlog cleared?** ☐ Yes ☐ No

**Status:** ☐ Pass ☐ Fail

**Time:** T+_____ min

---

## Observations & Findings

### What Went Well
- _____________________
- _____________________
- _____________________

### Issues Found

#### Issue 1: _______________
**Severity:** ☐ Critical ☐ High ☐ Medium ☐ Low

**Description:** _____________________

**Observed:** _____________________

**Impact:** _____________________

**Workaround:** _____________________

**Follow-up issue:** ☐ File #_____ ☐ Pending

#### Issue 2: _______________
**Severity:** ☐ Critical ☐ High ☐ Medium ☐ Low

**Description:** _____________________

**Observed:** _____________________

**Impact:** _____________________

**Workaround:** _____________________

**Follow-up issue:** ☐ File #_____ ☐ Pending

### Gaps vs. Documented Plan

| Component | Expected Behavior | Actual Behavior | Gap? | Notes |
|-----------|-------------------|-----------------|------|-------|
| Contract pause  | Blocks 6 ops | _____________ | ☐ Yes ☐ No | __________ |
| Indexer detection | Event within 3 ledgers | __________ | ☐ Yes ☐ No | __________ |
| Keeper bot detection | Stops claiming | __________ | ☐ Yes ☐ No | __________ |
| Fund recovery paths | All 4 paths work | __________ | ☐ Yes ☐ No | __________ |
| View availability | All 5 views responsive | __________ | ☐ Yes ☐ No | __________ |
| Unpause recovery | Full recovery | __________ | ☐ Yes ☐ No | __________ |

---

## Timeline Summary

| Phase | Start | End | Duration | Status |
|-------|-------|-----|----------|--------|
| Verification | T+0 | T+5 | 5 min | ☐ Pass ☐ Fail |
| Pause Execution | T+5 | T+10 | 5 min | ☐ Pass ☐ Fail |
| Blocked Operations | T+10 | T+20 | 10 min | ☐ Pass ☐ Fail |
| Allowed Operations | T+20 | T+30 | 10 min | ☐ Pass ☐ Fail |
| Unpause & Recovery | T+30 | T+40 | 10 min | ☐ Pass ☐ Fail |
| **Total** | | | **~40 min** | |

---

## Follow-Up Issues

Create GitHub issues for each gap found:

### Priority 1 (Must fix before mainnet)
- [ ] Issue created: _____________________
- [ ] Issue created: _____________________

### Priority 2 (Should fix before mainnet)
- [ ] Issue created: _____________________
- [ ] Issue created: _____________________

### Priority 3 (Nice to have)
- [ ] Issue created: _____________________

---

## Sign-Off

| Role | Name | Time | Signature |
|------|------|------|-----------|
| Incident Lead | _____________ | _____ | __________ |
| Ops Engineer | _____________ | _____ | __________ |
| Security Engineer | _____________ | _____ | __________ |
| Protocol Engineer | _____________ | _____ | __________ |

**Overall drill result:** ☐ PASS ☐ PASS WITH FINDINGS ☐ FAIL

**Ready for mainnet?** ☐ Yes ☐ No (explain: ___________________)

---

## Appendix: Useful Commands

### Get contract address
```bash
skn config show --profile testnet
```

### Check ledger number
```bash
stellar ledger --network testnet | tail -1
```

### Wait for event finality
```bash
# Watch for event to appear in indexer (retry up to 10 times)
for i in {1..10}; do
  curl -s "https://testnet-indexer.example.com/api/events?topics=paused" | jq . && break
  sleep 2
done
```

### Check transaction details
```bash
stellar tx info <TX_HASH> --network testnet
```

### Monitor bot health
```bash
watch -n 5 'curl -s http://localhost:3000/health | jq .'
```
