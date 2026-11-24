# Incident Response & Drill Documentation

This directory contains incident response plans, drill procedures, and post-incident reviews for the Soroban Keeper Network.

## Quick Navigation

**⏱️ In a hurry? Start here:**
- **5 min overview:** → `QUICK_START.md`
- **Quick ref for drill team:** → `QUICK_START.md` § "12. Questions?"

**📚 Full documentation:**
- **Incident response policy:** → `../docs/INCIDENT_RESPONSE.md`
- **Emergency pause drill:** → `drills/pause-drill-2026-11-20.md`
- **Acceptance criteria:** → `DRILL_SUMMARY.md`
- **Task completion report:** → `COMPLETION_REPORT.md`

---

## Directory Structure

```
incidents/
├── README.md                         # This file
├── QUICK_START.md                    # 5-minute team overview
├── DRILL_SUMMARY.md                  # Acceptance criteria & verification
├── COMPLETION_REPORT.md              # Task #506 completion summary
├── drills/                           # Drill procedures and results
│   └── pause-drill-2026-11-20.md    # Emergency pause drill runbook
└── reviews/                          # Post-incident reviews (TBD)
    └── (populated after real incidents)
```

---

## What Is This?

The emergency pause drill is a **quarterly security test** that verifies:

✅ The pause mechanism blocks new exposure (6 operations)  
✅ Fund recovery paths remain available (5 operations + all views)  
✅ The indexer detects pause events within SLA (< 3 ledgers)  
✅ The keeper bot stops claiming during pause  
✅ Normal operation resumes cleanly after unpause  

**This is NOT a real incident** — it's a low-risk practice run on testnet.

---

## Documents Overview

### 1. QUICK_START.md (5 min read)
**For:** Everyone on the team  
**Purpose:** Quick overview and execution guide

- What is this drill and why we run it
- When to schedule (quarterly + special cases)
- Quick 5-phase summary
- Success criteria
- FAQ

**Start here if you're new to the drill.**

---

### 2. drills/pause-drill-2026-11-20.md (20 min read, 40 min to execute)
**For:** Drill execution team (ops, security, protocol, SRE)  
**Purpose:** Step-by-step runbook for testnet

- Pre-drill setup checklist
- Phase 1: Verification (is system healthy?)
- Phase 2: Pause Execution (can we pause?)
- Phase 3: Blocked Operations (are 6 operations blocked?)
- Phase 4: Allowed Operations (do 5 recovery paths work?)
- Phase 5: Unpause & Recovery (can we resume?)
- Observations section (what went well? what failed?)
- Issues tracking (severity levels, follow-up issues)
- Timeline summary
- Sign-off section

**Use this to execute the drill on testnet.**

---

### 3. DRILL_SUMMARY.md (5 min read)
**For:** Team lead, security engineer  
**Purpose:** Verify acceptance criteria

- Acceptance criteria verification checklist
- Component verification breakdown
- Phase-by-phase component mapping
- Execution instructions
- Related documentation

**Read this before approving drill completion.**

---

### 4. COMPLETION_REPORT.md (5 min read)
**For:** Team lead, security engineer  
**Purpose:** Understand what was delivered

- Executive summary
- Deliverables breakdown (6 documents)
- Acceptance criteria met (both criteria ✅)
- Components verified
- How to use the documents
- Next steps

**Reference this for task status and what was built.**

---

### 5. ../docs/INCIDENT_RESPONSE.md (10 min read)
**For:** Everyone  
**Purpose:** Understand the incident response policy

- Severity levels (Critical, High, Medium, Low)
- Decision authority (who decides, who executes)
- Communication channels (#security-incidents, email)
- Pause mechanism policy (detailed)
- 5-phase response workflow
- Post-incident review template
- Emergency contacts

**Read this to understand the policy behind the drill.**

---

## Incident vs. Drill

| Aspect | Incident | Drill |
|--------|----------|-------|
| **Real?** | Yes, active security event | No, planned practice |
| **Risk** | High (funds at stake) | Low (testnet only) |
| **Response** | Immediate (< 15 min for Severity 1) | Scheduled (quarterly) |
| **Timeline** | Time-critical decisions | Relaxed, learning-focused |
| **Output** | Incident post-mortem | Drill findings & improvements |
| **Purpose** | Resolve and mitigate | Validate procedures |

**Drills → ensure incidents are handled correctly when they matter.**

---

## When to Run the Drill

### Scheduled (Regular)
- **Q1:** February (each year)
- **Q2:** May (each year)
- **Q3:** August (each year)
- **Q4:** November (each year)

### Unscheduled (As Needed)
- After any changes to pause logic or admin functions
- After a real security incident (verify fix)
- Before launching to mainnet (prerequisite)
- On-demand by security team decision

---

## How to Execute

### Before: Read This (10 min)
1. `QUICK_START.md` (overview for all)
2. `../docs/INCIDENT_RESPONSE.md` (policy context)

### During: Use This (40 min)
1. Open `drills/pause-drill-2026-11-20.md`
2. Follow 5 phases in order
3. Fill in observations as you test
4. Record pass/fail status
5. Note any gaps or issues

### After: Document This (15 min)
1. File any gaps as GitHub issues
2. Sign off (incident lead, ops, security, protocol)
3. Post summary to `#security-incidents`
4. Schedule follow-up fixes

**Total time:** ~65 minutes (10 min prep + 40 min drill + 15 min follow-up)

---

## Success Criteria

### ✅ PASS if:
- All 6 blocked operations rejected during pause
- All 5 allowed operations succeeded during pause
- Pause event detected by indexer within 3 ledgers
- Keeper bot detected pause and resumed correctly
- Full recovery after unpause (can register tasks again)

### ❌ FAIL if:
- Any blocked operation succeeded (pause gate failed)
- Any allowed operation failed (fund recovery broken)
- Pause event not detected by indexer
- Bot didn't detect pause or didn't resume
- Couldn't unpause or full recovery failed

---

## Related Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| Incident Response Plan | `../docs/INCIDENT_RESPONSE.md` | Policy & procedures |
| Architecture | `../docs/ARCHITECTURE.md` | System design, pause policy table |
| Contract Code | `../contracts/keeper-registry/src/admin.rs` | pause/unpause implementation |
| Views | `../contracts/keeper-registry/src/views.rs` | is_paused() view |
| Security Review | `../docs/GOVERNANCE_SECURITY_REVIEW.md` | Admin controls analysis |

---

## Getting Started

**New to the drill?**

1. Read `QUICK_START.md` (5 min)
2. Ask questions in `#security-incidents` or at team standup
3. Participate in next scheduled drill (February Q1)

**Team lead scheduling the drill?**

1. Review `COMPLETION_REPORT.md` (5 min)
2. Read `DRILL_SUMMARY.md` (5 min)
3. Open `drills/pause-drill-2026-11-20.md`
4. Schedule 65-minute session with ops, security, protocol, SRE
5. Send `QUICK_START.md` to participants 1 week before

**Need incident response policy details?**

→ `../docs/INCIDENT_RESPONSE.md` (complete policy reference)

---

## Questions?

See `QUICK_START.md` § "12. Questions?" for FAQ, or reach out to the security team in `#security-incidents`.

---

**Status:** ✅ Ready for team review and first execution

**Last updated:** November 20, 2026
