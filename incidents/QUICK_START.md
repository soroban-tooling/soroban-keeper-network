# Emergency Pause Drill — Quick Start Guide

**Time to read:** 5 minutes  
**Time to execute drill:** ~40 minutes  
**Last updated:** November 20, 2026

---

## 1. What Is This?

The emergency pause drill is a **quarterly test** of the Soroban Keeper Network's incident response procedures. It ensures:

- The pause mechanism works as documented
- The keeper bot detects pause and resumes correctly
- The indexer ingests pause events within expected time
- Fund recovery paths remain open while paused
- The team knows how to respond to security incidents

**This is NOT a real incident** — it's a practice run on testnet with low stakes.

---

## 2. When to Run This

- **Quarterly:** Schedule it as a regular recurring event (February, May, August, November)
- **After changes:** If you modify pause logic or admin functions, run the drill first
- **Before mainnet:** Must pass this drill before launching to mainnet
- **After incidents:** Run within 24 hours of resolving any real incident (to verify fixes)

---

## 3. Who Should Participate?

| Role | Responsibility |
|------|-----------------|
| **Ops engineer** | Executes pause/unpause CLI commands |
| **Security engineer** | Evaluates findings, approves drill completion |
| **Protocol engineer** | Verifies contract behavior matches docs |
| **DevOps/SRE** | Monitors indexer health and alerting |
| **Scribe** | Documents timeline and observations |
| **Team lead** | Observes decision-making (optional) |

**Minimum team:** 3 people (ops + security + one other)

---

## 4. Before You Start

**Checklist (10 min):**

- [ ] Read `docs/INCIDENT_RESPONSE.md` (understand the policy)
- [ ] Verify testnet contract is deployed and initialized
- [ ] Verify testnet indexer is running and synced (< 5 sec lag)
- [ ] Verify keeper bot v2 is running on testnet
- [ ] Prepare 5–10 PENDING tasks and 2–3 CLAIMED tasks
- [ ] Have a keeper account ready for testing (with non-zero balance)
- [ ] Gather the drill team in a Slack channel (`#security-incidents`)
- [ ] Open `incidents/drills/pause-drill-2026-11-20.md`

---

## 5. The 5-Phase Drill (40 minutes)

### Phase 1: Verification (T+0 to T+5 min)
**Goal:** Confirm system is healthy before we start

Run these 4 quick checks:
1. `is_paused()` returns `false` (contract not paused)
2. Indexer lag < 5 seconds
3. Keeper bot is running and healthy
4. Task count is > 5

**Expected outcome:** All checks pass  
**If any fail:** Fix the issue and try again later

### Phase 2: Pause Execution (T+5 to T+10 min)
**Goal:** Pause the contract and verify detection

Run 5 tests:
1. Call `pause()` with admin key
2. Check `is_paused()` returns `true`
3. Verify `paused` event appears in indexer (within 3 ledgers)
4. Check keeper bot logs for pause detection
5. Record timestamps and ledger numbers

**Expected outcome:** Pause confirmed in 3 places (contract, indexer, bot)  
**If any fail:** This is a critical gap — document and investigate

### Phase 3: Blocked Operations (T+10 to T+20 min)
**Goal:** Verify pause blocks new exposure

Try to execute these 6 operations (all should fail):
1. `register_task` — should fail ❌
2. `claim_task` — should fail ❌
3. `execute_task` — should fail ❌
4. `increase_reward` — should fail ❌
5. `extend_deadline` — should fail ❌
6. `stake_deposit` — should fail ❌

**Expected outcome:** All 6 fail with "ContractPaused" or similar error  
**If any succeed:** This is a critical gap — pause gate didn't work

### Phase 4: Allowed Operations (T+20 to T+30 min)
**Goal:** Verify fund recovery paths still work

Try to execute these 5 operations (all should succeed):
1. `cancel_task` — should succeed ✅ (owner recovery)
2. `expire_task` — should succeed ✅ (permissionless recovery)
3. `withdraw_rewards` — should succeed ✅ (keeper earnings access)
4. `withdraw_stake` — should succeed ✅ (keeper stake recovery)
5. All views (`get_task`, `task_count`, etc.) — should succeed ✅

**Expected outcome:** All 5 succeed  
**If any fail:** Fund recovery path is broken — critical gap

### Phase 5: Unpause & Recovery (T+30 to T+40 min)
**Goal:** Resume normal operation

Run 5 tests:
1. Call `unpause()` with admin key
2. Check `is_paused()` returns `false`
3. Verify you can `register_task` again (was blocked in Phase 3)
4. Check keeper bot logs for resume
5. Verify indexer has cleared pause backlog

**Expected outcome:** Full recovery, bot resumed, indexer caught up  
**If any fail:** Unpause didn't work — critical gap

---

## 6. Recording Your Findings

**Fill in all observation fields as you go:**

- ✅ What passed?
- ❌ What failed?
- ⚠️ What was slower/faster than expected?
- 🔄 Any timeouts or retries needed?
- 💭 Did the bot behave as documented?

**Example observation:**
> Indexer detected pause event within 2 ledgers (faster than 3-ledger SLA). Keeper bot paused claiming within 30 seconds of event ingestion. All fund recovery paths worked perfectly. No gaps found.

---

## 7. Finding Gaps & Filing Issues

For any unexpected behavior:

1. **Record it:** Write down what you expected vs. what happened
2. **Categorize:** Is this a Critical/High/Medium/Low gap?
3. **File an issue:** Create a GitHub issue with:
   - Title: `test(security): [description]` or `fix(contract): [description]`
   - Labels: `security`, `testing`
   - Severity: Critical, High, Medium, Low
   - Description: What went wrong + impact + reproduction steps
4. **Link to drill:** Reference this drill document in the issue
5. **Update checklist:** Mark the issue in the drill document

**Example issue filing:**
```
Issue: Keeper bot did not detect pause (12-second delay)
Severity: Medium
Expected: Bot detects pause event within 5 seconds
Actual: 12-second delay before bot stopped claiming
Impact: During real incident, keepers might claim during pause window
Solution: TBD (optimize bot event polling)
```

---

## 8. What Happens After the Drill?

**Day 1 (Same day as drill):**
- [ ] All participants fill in observations
- [ ] Incident lead signs off (PASS or PASS WITH FINDINGS)
- [ ] File all follow-up issues
- [ ] Post summary in `#security-incidents`

**Day 2-7:**
- [ ] Team lead reviews findings
- [ ] Prioritize follow-up issues (P1, P2, P3)
- [ ] Assign fixes for High/Critical gaps
- [ ] Schedule fixes before next drill or mainnet launch

**Before next drill (3 months later):**
- [ ] All Critical/High gaps must be fixed
- [ ] Medium gaps should be fixed (can defer if low impact)
- [ ] Low gaps logged as tech debt (no hard deadline)

---

## 9. Useful Commands

### Get contract address (from config)
```bash
skn config show --profile testnet | grep contract
```

### Check if paused
```bash
stellar contract invoke --id $CONTRACT --source $ADMIN --network testnet -- is_paused
```

### Call pause
```bash
stellar contract invoke --id $CONTRACT --source $ADMIN --network testnet \
  -- pause --admin $ADMIN_ADDRESS
```

### Check bot logs (if running in Docker)
```bash
docker logs keeper-bot-v2 | tail -100
```

### Wait for indexer event
```bash
# Poll indexer up to 10 times, waiting for pause event
for i in {1..10}; do
  curl -s https://testnet-indexer.example.com/api/events?topics=paused | jq . && break
  sleep 2
done
```

### Monitor indexer lag
```bash
watch -n 2 'curl -s https://testnet-indexer.example.com/api/health | jq ".lag_ms"'
```

---

## 10. Success Criteria

**The drill is successful if:**

✅ All 6 blocked operations rejected during pause  
✅ All 5 allowed operations succeeded during pause  
✅ Pause event detected by indexer within 3 ledgers  
✅ Keeper bot detected pause and resumed correctly  
✅ Full recovery after unpause (can register tasks again)  
✅ Indexer caught up after unpause  

**The drill has critical gaps if:**

❌ Any blocked operation succeeded (pause gate failed)  
❌ Any allowed operation failed (fund recovery broken)  
❌ Pause event not detected by indexer  
❌ Bot didn't detect pause or didn't resume  
❌ Couldn't unpause or full recovery failed  

---

## 11. Document References

| Document | Purpose | Read Time |
|----------|---------|-----------|
| `docs/INCIDENT_RESPONSE.md` | Full incident response policy | 10 min |
| `incidents/drills/pause-drill-2026-11-20.md` | Detailed drill runbook | 20 min |
| `incidents/DRILL_SUMMARY.md` | Acceptance criteria & verification | 5 min |
| `docs/ARCHITECTURE.md` § Pause Policy | Contract pause gate details | 5 min |

---

## 12. Questions?

**"What if X fails?"**  
→ Record it, file an issue, investigate in post-drill meeting

**"Can I run this locally?"**  
→ Not recommended (need testnet environment). Run on testnet with full team.

**"How do I know if the pause gate is working?"**  
→ Try the 6 blocked operations during Phase 3. If any succeeds, the gate is broken.

**"What if the indexer is too slow?"**  
→ If indexer lag > 10 seconds during drill, this is a separate issue. File a gap.

**"Do I need the bot running?"**  
→ Yes. The drill verifies the bot detects pause and resumes. Without it, you can't fully validate.

**"What about mainnet — do we drill that too?"**  
→ No. Drills happen on testnet only. Before mainnet launch, this drill must pass.

---

## 13. Feedback Loop

After each drill:

1. **What went well?** (Keep doing it)
2. **What was unclear?** (Update the runbook)
3. **What was missing?** (Add to next version of incident response plan)
4. **What needs fixing?** (File issues, prioritize fixes)

**Feedback goes here:** Reply in the drill post-mortem thread in `#security-incidents`

---

**Next scheduled drill:** [Team to fill in]

**Last drill:** November 20, 2026 (Initial setup)

**Status:** Ready for first execution
