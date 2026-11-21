# Incident Response Plan

## Purpose

This document defines the procedures, roles, and communication channels for responding to security incidents in the Soroban Keeper Network. It covers severity levels, decision authority, execution steps, and post-incident review processes.

## Severity Levels

### Severity 1 (Critical)
- **Definition:** Active loss of funds, contract compromise, or exploitable vulnerability
- **Examples:** Unauthorized fund transfer, contract pause mechanism failure, private key compromise
- **Response time:** Immediate (< 15 minutes)
- **Action:** Emergency pause + manual review + immediate disclosure

### Severity 2 (High)
- **Definition:** Significant operational risk or data integrity issue
- **Examples:** Indexer lag > 1 hour, bot profitability calculation drift, storage archive
- **Response time:** 1 hour
- **Action:** Pause + investigation + disclosure within 24 hours

### Severity 3 (Medium)
- **Definition:** Degraded functionality or minor security findings
- **Examples:** Rate limiting configuration drift, deprecated dependency, documentation gap
- **Response time:** 24 hours
- **Action:** Investigation + fix + disclosure within 1 week

### Severity 4 (Low)
- **Definition:** Non-blocking issues or recommendations
- **Examples:** Code style findings, test coverage gaps
- **Response time:** Next sprint
- **Action:** Backlog as regular issue

## Decision Authority

### Who Can Declare an Incident?
- **Severity 1 or 2:** Any team member can declare; all ops/security team members are notified immediately
- **Severity 3 or 4:** Team lead approval required; filed as a regular issue

### Who Can Authorize Pause?
- **Primary:** Current admin key holder (designated ops engineer)
- **Fallback:** Secondary admin key (backup ops engineer)
- **Verification:** Both keyholder and one other team member must verbally confirm incident severity before pause execution

### Who Executes the Pause?
- The authorized party calls `pause()` with valid admin signature
- All participants log observations in the shared incident channel

## Communication Channels

### Immediate Notification (Severity 1–2)
- **Primary:** Slack channel `#security-incidents` (real-time alerts + decision log)
- **Secondary:** Email to security@soroban-keeper-network (audit trail)
- **Escalation:** On-call engineer (if after hours)

### Decision Log
- All pause/unpause decisions are logged in `#security-incidents` with timestamp, reason, and approvers
- Logs are exported daily to `incidents/log/YYYY-MM-DD.md` for retention

### Post-Incident Review
- Scheduled within 24 hours of incident resolution
- Conducted in a recorded meeting (Zoom) with full ops/security/dev team
- Output saved to `incidents/reviews/post-incident-<date>.md`

## Pause Mechanism

The `pause()` function in `KeeperRegistry` blocks new exposure while preserving withdraw paths:

| Entry point       | While paused | Rationale |
|-------------------|--------------|-----------|
| `register_task`   | BLOCKED      | Prevents new escrow exposure |
| `claim_task`      | BLOCKED      | Prevents new keeper exposure |
| `execute_task`    | BLOCKED      | Prevents payout of new rewards |
| `increase_reward` | BLOCKED      | Prevents extending escrow |
| `extend_deadline` | BLOCKED      | Prevents reopening paused tasks |
| `cancel_task`     | **allowed**  | Owner fund recovery (liveness) |
| `expire_task`     | **allowed**  | Permissionless fund recovery |
| `withdraw_rewards`| **allowed**  | Keeper earning withdrawal (liveness) |
| `stake_deposit`   | BLOCKED      | Prevents new keeper exposure |
| `withdraw_stake`  | **allowed**  | Keeper stake recovery |
| All views         | **allowed**  | Read-only, never gated |

## Incident Response Process

### Phase 1: Detection (0–5 min)
1. **Incident discovered** via monitoring alert, security report, or user report
2. **Initial assessment:** Verify the incident is genuine (not a false alarm)
3. **Severity classification:** Determine level and escalate to decision authority
4. **Notification:** Post to `#security-incidents` with severity, description, and affected components

### Phase 2: Containment (5–15 min for Severity 1)
1. **Pause decision:** Decision authority reviews severity + recommends pause
2. **Approval:** Second verifier confirms decision
3. **Pause execution:** Authorized keyholder calls `pause()` and confirms in logs
4. **Verification:** All participants confirm pause completed via `is_paused()` view
5. **Communication:** Post confirmation to `#security-incidents` with timestamp

### Phase 3: Investigation (15 min – 24 hours depending on severity)
1. **Data collection:** Gather transaction logs, indexer state, bot metrics
2. **Root-cause analysis:** Determine what went wrong and why
3. **Scope assessment:** Identify affected users, tasks, or balances
4. **Fix development:** Create and test corrective action (contract upgrade, bot restart, etc.)
5. **Documentation:** Record all findings in a shared investigation doc

### Phase 4: Remediation & Unpause (Once fix is ready + verified)
1. **Final verification:** Deploy fix to testnet and rerun the scenario
2. **Unpause approval:** Decision authority approves unpause
3. **Unpause execution:** Call `unpause()` and confirm in logs
4. **Monitoring:** Increase monitoring cadence for 1 hour post-unpause
5. **Communication:** Post all-clear message to `#security-incidents`

### Phase 5: Disclosure & Post-Incident Review
1. **Disclosure:** Inform affected parties (users, stakers, keepers) within severity window
   - Severity 1–2: within 24 hours
   - Severity 3: within 1 week
2. **Public disclosure:** File a GitHub advisory or post-mortem in `docs/`
3. **Post-incident review meeting:** Held within 24 hours of resolution
4. **Remediation tracking:** All follow-up issues filed in backlog

## Post-Incident Review Template

Use this template for every Severity 1–2 incident:

```markdown
# Post-Incident Review — [Date]

## Summary
[One-sentence description of the incident]

## Timeline

| Time (UTC) | Event | Owner |
|----------|-------|-------|
| 14:22 | Incident detected via alert | [Name] |
| 14:27 | Severity 1 declared | [Name] |
| 14:33 | Pause decision made | [Name] |
| 14:35 | Pause executed (tx hash: ...) | [Name] |
| ... | Investigation complete | [Name] |
| ... | Unpause executed | [Name] |

## Impact
- Tasks affected: [count]
- Keepers affected: [count]
- Duration: [minutes]
- Funds at risk: [amount or "none"]

## Root Cause
[Technical explanation of what went wrong]

## Resolution
[What was done to fix it]

## Action Items (Follow-up Issues)
- [ ] Issue #XXX: [Description]
- [ ] Issue #YYY: [Description]

## Drill Observations (if applicable)
[Gaps found during the pause drill]

## Approvals
- Incident lead: ___________
- Ops review: ___________
- Security review: ___________
```

## Emergency Contacts

### Primary On-Call
- Name: [To be configured]
- Phone: [To be configured]
- Slack: @oncall

### Secondary On-Call
- Name: [To be configured]
- Phone: [To be configured]

### Escalation (If no response in 30 min)
- Team lead
- CEO / Head of Security

## Testing & Drills

### Pause Drill (This Document)
- **Frequency:** Quarterly (or after major changes to pause logic)
- **Participants:** Full ops + security team
- **Duration:** 1–2 hours
- **Scope:** Execute pause → verify all components react as documented → unpause → collect observations
- **Output:** `incidents/drills/pause-drill-YYYY-MM-DD.md`

### Full Incident Simulation (Annual)
- Simulates a real Severity 1 incident from start to finish
- Tests communication, decision-making, and recovery procedures
- Held once per year with external observers

## Related Documents

- Contract code: `contracts/keeper-registry/src/admin.rs` (pause/unpause logic)
- Views: `contracts/keeper-registry/src/views.rs` (is_paused)
- Architecture: `docs/ARCHITECTURE.md` (pause policy table)
- Audit scope: `docs/AUDIT_SCOPE.md`
- Security review: `docs/GOVERNANCE_SECURITY_REVIEW.md` (admin controls)

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-11-20 | [Author] | Initial version |
