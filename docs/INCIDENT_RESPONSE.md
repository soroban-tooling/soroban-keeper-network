# Incident Response Plan

This document defines the incident response procedures for the Soroban Keeper Network, including severity levels, decision rights, communication channels, and post-incident review processes.

## Table of Contents

- [Severity Levels](#severity-levels)
- [Roles and Decision Rights](#roles-and-decision-rights)
- [Communication Channels](#communication-channels)
- [Response Timeline](#response-timeline)
- [Incident Management](#incident-management)
- [Fix Disclosure](#fix-disclosure)
- [Post-Incident Review Template](#post-incident-review-template)

---

## Severity Levels

All incidents are classified by the potential impact to users, the network, and funds. This classification drives response speed and escalation.

### Critical

**Criteria:**
- Direct loss or at-risk loss of user funds or escrowed task rewards
- Complete unavailability of keeper execution (contract paused indefinitely)
- Authentication or authorization bypass affecting multiple keepers or tasks
- Reentrancy, storage collision, or integer overflow causing unintended state mutation
- Exploitation of upgrade mechanism to deploy malicious WASM
- Event spoofing that breaks task tracking or reward accounting

**Response Time:** Incident commander assembles team within **1 hour**.

**Initial Action:** Pause the contract immediately if exploit is active.

---

### High

**Criteria:**
- Significant degradation of service (>50% of keepers unable to execute tasks)
- Data integrity issues affecting task history or keeper reputations
- Partial or intermittent loss of funds (recoverable but with loss of value)
- DoS attack on contract endpoints lasting >10 minutes
- Vulnerability in keeper bot example or documentation that could mislead operators

**Response Time:** Incident commander assembles team within **4 hours**.

**Initial Action:** Begin root cause analysis; pause if exploitation is likely.

---

### Medium

**Criteria:**
- Partial service degradation (<50% of keepers affected)
- Incorrect reward calculation affecting <10 tasks
- Off-chain indexer data drift from on-chain state
- Non-critical dependency vulnerability with no active exploit
- Misconfiguration of governance or oracle endpoints

**Response Time:** Incident commander assembles team within **24 hours**.

**Initial Action:** Begin root cause analysis; no automatic pause.

---

### Low

**Criteria:**
- Minor service issues with automatic recovery
- Cosmetic or UX bugs in keeper bot
- Documentation errors or typos
- Informational security findings with negligible risk

**Response Time:** Triage and plan within **5 business days**.

**Initial Action:** Log the issue; no escalation required.

---

## Roles and Decision Rights

### Incident Commander

**Appointed by:** Security Lead or project maintainer on duty.

**Responsibilities:**
- Declare the incident and assign severity level
- Assemble the response team
- Coordinate communication with stakeholders
- Make pause/unpause decisions (for Critical/High incidents)
- Authorize emergency fixes and deployments
- Schedule the post-incident review

**Authority:**
- Can pause the contract without waiting for consensus (Critical/High only)
- Can authorize emergency hotfix deployments to `main` branch
- Can communicate directly with users about ongoing incidents

---

### Security Lead

**Appointed by:** Project maintainers at project kickoff.

**Responsibilities:**
- Designate Incident Commander if not already active
- Oversee technical investigation
- Review emergency patches for correctness
- Approve timeline extensions for fixes
- Coordinate with external auditors or researchers if needed

**Authority:**
- Can override Incident Commander decisions on technical grounds
- Can expand or narrow the response team
- Can authorize disclosure timelines

---

### Treasury Manager

**Appointed by:** Project maintainers (for Phase 2+ governance, this may be automated or delegated to a DAO).

**Responsibilities:**
- Monitor fund transfers during incident
- Prepare compensation or recovery plan if funds are lost
- Track costs of incident response
- Authorize emergency fund allocation for security fixes

**Authority:**
- Can approve fund recovery or compensation claims
- Can allocate budget for expedited security research

---

### Communication Lead

**Appointed by:** Incident Commander.

**Responsibilities:**
- Draft all external communications (GitHub advisories, email, tweets)
- Coordinate timing of disclosures
- Maintain incident status page or channel
- Collect and summarize updates from technical team

**Authority:**
- Can delay public disclosure if Security Lead approves (e.g., for coordinated patching)
- Can post interim updates without incident commander approval

---

### On-Call Engineer

**Appointed by:** Project maintainers (rotates weekly or monthly).

**Responsibilities:**
- First responder to reported security issues
- Triage severity and notify Incident Commander
- Begin initial investigation
- Preserve evidence and logs

**Authority:**
- Can temporarily disable features or pause contract to stop active exploitation
- Can convene the response team

---

## Communication Channels

### Internal

- **Slack/Discord:** `#security-incidents` (or equivalent private channel)
  - Real-time status updates during response
  - Technical discussion and decision-making
  - Only security-cleared team members

- **GitHub Issue (Private):** 
  - Detailed incident log and timeline
  - Links to fix PRs and deployment records
  - Preserved for post-incident review

- **Email (security@soroban-keeper.network):**
  - Formal incident notification if primary channels are unavailable
  - Off-hours escalation

### External

- **GitHub Security Advisory:**
  - Used for coordinated disclosure of patched vulnerabilities
  - Auto-notifies all watchers and advisories subscribers
  - Follow GitHub's [CVSS scoring](https://www.first.org/cvss/calculator/3.1) guidance

- **Email to security@soroban-keeper.network:**
  - Sent to users and protocol integrators once patch is released
  - Includes: severity, impact, fix version, and upgrade instructions

- **Twitter/Social Media (if Critical):**
  - High-level alert (no technical details)
  - Link to advisory and upgrade guide
  - Posted after fix is deployed and tested

- **Status Page (if applicable):**
  - Real-time status for ongoing incidents
  - May be GitHub status page or dedicated service

---

## Response Timeline

### Critical Incidents

| Phase | Owner | Deadline | Activity |
|-------|-------|----------|----------|
| Discovery | On-Call Eng. | Immediate | Triage, notify Incident Commander |
| Escalation | Incident Cmdr | +15 min | Declare Critical, assemble team, determine pause necessity |
| Initial Response | Incident Cmdr + Security | +30 min | Pause contract (if active exploitation), preserve logs, begin root cause analysis |
| Rapid Fix | Security Eng. | +2 hours | Develop emergency patch; Security Lead review |
| Deployment | Incident Cmdr | +4 hours | Deploy fix to testnet, validate, then mainnet |
| Communication | Comms Lead | +4 hours | Post GitHub advisory (without full technical details, if needed) |
| Post-Incident Review | Incident Cmdr | +48 hours | Schedule review meeting |

### High Incidents

| Phase | Owner | Deadline | Activity |
|-------|-------|----------|----------|
| Discovery | On-Call Eng. | Immediate | Triage, notify Incident Commander |
| Escalation | Incident Cmdr | +1 hour | Declare High, assemble team |
| Investigation | Security Eng. | +12 hours | Root cause analysis; decide pause necessity |
| Fix Development | Security Eng. | +48 hours | Develop patch, Security Lead review |
| Testing | QA/Testing | +72 hours | Testnet validation |
| Deployment | Incident Cmdr | +96 hours (4 days) | Mainnet deployment |
| Disclosure | Comms Lead | +100 hours | Public advisory |
| Post-Incident Review | Incident Cmdr | +1 week | Schedule review meeting |

### Medium Incidents

| Phase | Owner | Deadline | Activity |
|-------|-------|----------|----------|
| Discovery | On-Call Eng. | Immediate | Triage, file issue |
| Triage | Security Lead | +24 hours | Confirm severity, assign owner |
| Fix Development | Assigned Eng. | +1 week | Standard PR process |
| Testing | Assigned Eng. | +1 week | Unit and integration tests |
| Deployment | Assigned Eng. | +2 weeks | Regular release cycle |
| Disclosure | Comms Lead | +1 month | Advisor with fix version number |

---

## Incident Management

### Pause Decision Tree

**Question 1:** Are funds or rewards at direct risk *right now*?
- **YES** → Go to Q2
- **NO** → No pause required; proceed with normal fix process

**Question 2:** Can we stop the exploitation by pausing the entire contract?
- **YES, and doing so stops active loss** → PAUSE immediately; notify all users
- **NO, or pause causes more harm** → Do not pause; accelerate fix and deployment

**Question 3:** Is there time to deploy a targeted fix (e.g., revoke permissions) instead of pausing?
- **YES, <2 hours** → Deploy targeted fix; skip full pause
- **NO, >2 hours** → Pause; develop fix in parallel

### Pause Procedure

1. **Incident Commander** confirms pause necessity with Security Lead
2. **On-Call Engineer** or designated multisig signer initiates contract pause
3. **Communication Lead** sends immediate notification:
   - GitHub issue comment (if public)
   - Email to security contacts
   - Slack/Discord announcement
4. **Security Team** develops fix while contract is paused
5. **Incident Commander** authorizes unpause once fix is tested and deployed

**Note:** Pause decisions are logged in the private GitHub issue for post-incident review.

---

## Fix Disclosure

### Timing

- **Critical bugs:** Disclose once patch is deployed and validated in production (or after 90-day embargo is honored if coordinating with researcher)
- **High bugs:** Disclose once patch is released (no embargo required)
- **Medium/Low bugs:** Disclose in next routine release notes; no separate advisory needed

### Format

All disclosures follow this structure:

1. **Summary:** One-line impact (e.g., "Keeper rewards calculation vulnerability")
2. **Severity:** CVSS score (if applicable)
3. **Affected Versions:** List version ranges (e.g., "1.0.0 to 1.2.1")
4. **Fixed In:** Version number
5. **Details:** High-level description of the bug (no step-by-step exploit code)
6. **Upgrade Instructions:** How to deploy the fix
7. **Credits:** Names of reporters and researchers (if approved)
8. **Timeline:** Disclosure date and any embargo period honored

### Example Advisory

```
# Security Advisory: Keeper Reward Escrow Calculation Vulnerability

## Summary
A bug in reward distribution logic could allow keepers to drain the escrow 
by claiming rewards for completed tasks multiple times.

## Severity
High (CVSS 7.5)

## Affected Versions
- 1.0.0 through 1.1.2

## Fixed In
- 1.1.3 (patch)

## Details
Due to insufficient state validation in `claim_reward()`, a keeper's 
completed task was not marked as claimed before transferring funds. 
This allowed repeated claims until the escrow was depleted.

## Upgrade Instructions
Update to version 1.1.3 or later. No additional migration steps required.

## Credits
- Reported by: Jane Smith (@security-researcher)
- Fixed by: Soroban Keeper Network core team

## Timeline
- 2025-06-15: Vulnerability reported
- 2025-06-16: Confirmed and flagged as High
- 2025-06-22: Fix deployed to production
- 2025-06-23: Advisory published
```

---

## Post-Incident Review Template

**Incident ID:** `INC-YYYY-MM-DD-001` (assigned by Incident Commander)

**Review Date:** [Date meeting held]

**Review Meeting Attendees:**
- Incident Commander: [Name]
- Security Lead: [Name]
- Primary Responders: [Names]
- Treasury Manager (if funds were affected): [Name]
- Communication Lead: [Name]

---

### 1. Incident Summary

**What happened?**
[1–2 paragraph summary of the incident, including discovery date/time, severity, and how it was resolved]

**Timeline:**
| Time (UTC) | Event |
|------------|-------|
| YYYY-MM-DD HH:MM | Vulnerability reported / discovered |
| HH:MM | Severity classified as [Critical/High/Medium/Low] |
| HH:MM | [Key decision or action] |
| HH:MM | Contract paused (if applicable) |
| HH:MM | Fix deployed to testnet |
| HH:MM | Fix validated |
| HH:MM | Fix deployed to production |
| HH:MM | Public advisory issued (if applicable) |

---

### 2. Impact Assessment

**Scope of Impact:**
- Number of affected users/keepers: [X]
- Total funds at risk: [amount in XLM or USD equivalent]
- Total funds lost (if applicable): [amount]
- Contract downtime: [duration]
- Services affected: [list]

**Data Loss or Corruption:**
- Data lost: [None / describe what was lost]
- Data recoverable: [Yes/No, describe plan if yes]
- Need for manual reconciliation: [Yes/No]

**Reputation Impact:**
- User trust score: [low / medium / high concern]
- Media coverage: [None / limited / significant]
- Follow-up actions needed: [e.g., communication campaign, increased security audits]

---

### 3. Root Cause Analysis

**Direct Cause:**
[Specific technical root cause; reference code, logic error, or misconfiguration]

**Contributing Factors:**
- [Factor 1: e.g., "Lack of integration tests for multi-claim scenarios"]
- [Factor 2: e.g., "Insufficient code review of reward distribution logic"]
- [Factor 3: e.g., "No staging environment that mirrors production config"]

**Why It Wasn't Caught Earlier:**
[Explanation of why this made it past code review, testing, or audit]

---

### 4. Corrective Actions

**Immediate Actions (Already Completed):**
- [Action 1: e.g., "Deployed hotfix to production"]
- [Action 2: e.g., "Refunded affected users $X"]
- [Action 3: e.g., "Posted public advisory"]

**Short-Term Actions (Next 2 weeks):**
- [ ] [Action]: Owner: [Name], Deadline: [Date]
- [ ] [Action]: Owner: [Name], Deadline: [Date]

**Long-Term Actions (Next 3 months):**
- [ ] [Action]: Owner: [Name], Deadline: [Date]
- [ ] [Action]: Owner: [Name], Deadline: [Date]

**Process Improvements:**
- [ ] [Improvement]: e.g., "Add integration test suite for reward claims"
- [ ] [Improvement]: e.g., "Implement staged rollout for contract upgrades"
- [ ] [Improvement]: e.g., "Increase frequency of security audits"

---

### 5. Lessons Learned

**What Went Well:**
- [Positive aspect of response; e.g., "Team mobilized quickly," "Good communication"]
- [Positive aspect; e.g., "Testnet deployment validated the fix before mainnet"]

**What Could Be Improved:**
- [Gap or delay; e.g., "Took 3 hours to locate primary responder"]
- [Gap; e.g., "Lacked a runbook for pausing the contract"]
- [Gap; e.g., "Insufficient documentation of escrow state management"]

**Changes to Incident Response Process:**
- [Process change; e.g., "Create on-call rotation in Opsgenie"]
- [Process change; e.g., "Add security review checklist for reward logic"]

---

### 6. Prevention and Hardening

**Code Changes:**
- PR: [Link to fix PR]
- Additional hardening: [Describe any additional security measures added beyond the minimal fix]

**Testing Improvements:**
- New test cases added: [List key tests]
- Coverage increase: [Previous: X%, New: Y%]

**Monitoring and Alerting:**
- [Monitoring rule added; e.g., "Alert if `claim_reward` called twice for same task"]
- [Alert added; e.g., "Slack notification if contract pause event fires"]

**Documentation:**
- [ ] Runbook created/updated
- [ ] Architecture documentation updated
- [ ] Security model documentation updated

---

### 7. Stakeholder Communication

**Internal Communications Sent:**
- [ ] Email to engineering team: [Date]
- [ ] All-hands meeting: [Date]
- [ ] Update to product roadmap: [Date]

**External Communications Sent:**
- [ ] GitHub Security Advisory: [Link]
- [ ] Email to users: [Date sent]
- [ ] Twitter / social media post: [Link]
- [ ] Detailed blog post or postmortem: [Link, if applicable]

**Ongoing Communications:**
- User compensation plan (if applicable): [Link to details]
- Plan for rebuilt trust: [Description]

---

### 8. Sign-Off

**Incident Commander Approval:**
- Name: [Name]
- Date: [Date]
- Signature/confirmation: [GitHub handle or email]

**Security Lead Approval:**
- Name: [Name]
- Date: [Date]
- Signature/confirmation: [GitHub handle or email]

**Treasury Manager Approval (if applicable):**
- Name: [Name]
- Date: [Date]
- Signature/confirmation: [GitHub handle or email]

---

## Appendix: Incident Response Contacts

### On-Call Rotation

| Week | On-Call Engineer | Backup | Contact |
|------|------------------|--------|---------|
| 2025-01-01 | Alice Johnson | Bob Chen | [Slack/Phone] |
| 2025-01-08 | Bob Chen | Carol Lee | [Slack/Phone] |
| 2025-01-15 | Carol Lee | Alice Johnson | [Slack/Phone] |

To update: Edit this table or reference a dedicated on-call calendar (e.g., PagerDuty, Opsgenie).

### Key Contacts

- **Security Lead:** security-lead@soroban-keeper.network
- **Incident Commander (Default):** project-lead@soroban-keeper.network
- **Treasury Manager:** treasury@soroban-keeper.network
- **General Security Inquiries:** security@soroban-keeper.network

### Escalation

- If no response within **15 minutes** from On-Call Engineer, ping Backup On-Call
- If no response within **30 minutes** from both, escalate to Security Lead

---

## Appendix: Post-Incident Review Meeting Checklist

**Before the Meeting:**
- [ ] Incident Commander schedules meeting (within 48 hours of incident resolution)
- [ ] All required attendees invited
- [ ] Timeline and key events documented
- [ ] Impact assessment completed
- [ ] Root cause analysis drafted

**During the Meeting:**
- [ ] Review timeline (should take <30 min)
- [ ] Discuss root cause (20–40 min)
- [ ] Brainstorm corrective actions (15–30 min)
- [ ] Identify process improvements (10–20 min)
- [ ] Assign owners and deadlines for follow-ups
- [ ] Schedule follow-up meeting to confirm completion (if many long-term actions)

**After the Meeting:**
- [ ] Communication Lead publishes redacted summary (if public incident)
- [ ] Incident Commander shares final review document with team
- [ ] Owners begin corrective actions per assigned deadlines
- [ ] Security Lead audits corrective actions at milestone dates
- [ ] Incident marked as "Resolved" in tracking system once all actions complete

---

## References

- [SECURITY.md](../SECURITY.md) — Vulnerability reporting and disclosure policy
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework) — Incident response best practices
- [CISA Incident Management](https://www.cisa.gov/resources/tools-and-services/incident-management) — U.S. government guidance

