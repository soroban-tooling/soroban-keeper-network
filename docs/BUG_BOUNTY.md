# Bug Bounty Program

## Overview

The Soroban Keeper Network maintains a formal bug bounty program to incentivize responsible security research and improve the safety of the protocol. This program defines the scope of eligible findings, severity tiers, payout ranges, and safe-harbor terms.

## Scope

### In Scope

The following are eligible for bounty rewards:

#### Task Lifecycle & Escrow

- Task registration, claiming, execution, cancellation, expiration, or withdrawal logic
- Escrow integrity (funds incorrectly released or stranded)
- Double-payout scenarios (a task reward paid more than once)
- Reward accounting mismatches
- Related code: `contracts/keeper-registry/src/task.rs`

#### Admin Controls

- Privilege escalation or authorization bypass
- Unauthorized pause, fee modification, sweep, admin transfer, or upgrade
- Admin accessing task escrow or keeper balances outside `sweep_fees`
- Related code: `contracts/keeper-registry/src/admin.rs`

#### Batch Registration

- Atomicity violations in batch operations
- Inconsistent state after partial batch failure
- Related code: `contracts/keeper-registry/src/batch.rs`

#### TTL / Archival

- Improper TTL renewal causing unintended archival
- Archived storage blocking contract liveness
- Related code: `contracts/keeper-registry/src/internal.rs` (TTL renewal logic)

#### Staking, Unbonding, Slashing, and Dispute Windows

- Slash exceeding a keeper's stake (violates invariant I-10)
- Double-counting staked vs. withdrawable funds (violates invariant I-11)
- Unbonding request bypassing or circumventing delay windows
- Related code: `contracts/keeper-registry/src/staking.rs`

#### Keeper Reputation

- Reputation score manipulation or inflation
- Incorrect decay application
- Unauthorized reputation modification
- Related code: `contracts/keeper-registry/src/reputation.rs`

#### Treasury Fee Routing

- Incorrect fee distribution or splits
- Fee sweeps accessing non-accrued balances
- Treasury integration failures
- Related code: `contracts/keeper-registry/src/admin.rs` (sweep_fees), `contracts/treasury/src/lib.rs`

#### Verifier Integration

- Verifier capable of transferring funds or mutating task state (violates invariant I-8)
- Verifier call happening after state mutation
- Insufficient isolation of verifier failures
- Related design: `docs/VERIFIER_DESIGN.md`

#### Money Invariants

Any violation of the core solvency and safety invariants `I-1` through `I-11` as documented in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#money-invariants):

- **I-1** — Solvency: contract balance equals escrow + keeper balances + fees
- **I-2** — Escrow recoverability: every escrowed reward has a reachable payout path
- **I-3** — Single payout: each task reward paid exactly once
- **I-4** — Fee bounding: fees never exceed the configured basis points
- **I-5** — Escrow isolation: admin functions cannot touch task escrow or keeper balances
- **I-6** — Withdrawal liveness: keeper withdrawals always available, even when paused
- **I-7** — Monotonic task ids: task ids are unique and never reused
- **I-8** — Verifier trust boundary: verifiers cannot move funds or mutate task state
- **I-9** — Staking isolation: staked funds never spendable as task escrow or keeper reward
- **I-10** — Slash bounds: slashes never exceed current stake
- **I-11** — Unbond double-counting: unbonding funds not double-counted as both staked and withdrawable

### Out of Scope

The following are **not** eligible for bounty rewards:

- **Dependencies** — Publicly disclosed vulnerabilities in upstream dependencies (report to the dependency maintainer)
- **Theoretical attacks** — Attacks with no practical exploit path or unrealistic preconditions
- **Spam / Griefing** — Issues that only harm the attacker economically (e.g., registering and immediately canceling tasks, false slashing claims without impact)
- **Off-chain infrastructure** — The keeper bot example (`examples/keeper-bot/`) and batch-register scripts; these are illustrative, not production code
- **Front-end or UX issues** — Client-side bugs not affecting contract state
- **Documentation inconsistencies** — Unless accompanied by a corresponding contract vulnerability
- **Private key exposure in examples** — Unless the key is also deployed on a production network

---

## Severity Tiers

Severity is determined by the concrete impact on users, funds, or protocol integrity. Each tier references the type of harm possible:

### Critical

**Direct fund loss or protocol insolvency**

Findings that result in one or more of:
- An attacker stealing escrowed task rewards, keeper balances, or accrued fees
- Task or keeper funds becoming permanently unrecoverable
- Violating a core money invariant (I-1, I-2, I-3, I-5, I-6, I-8) resulting in token loss
- Unauthorized admin takeover leading to above outcomes
- Contract becoming insolvent (I-1)

**Examples:**
- Double-payout vulnerability allowing a keeper to claim the same reward twice
- Auth bypass allowing an attacker to call `sweep_fees` without authorization
- Escrow funds released without proper execution
- Verifier capable of stealing funds (I-8 violation)

**Payout:** **$10,000 – $50,000 USD equivalent in XLM**

### High

**Significant disruption without direct token loss**

Findings that result in one or more of:
- Denial of service (core contract functions become unusable)
- Privilege escalation (non-admin calling admin functions)
- Violation of I-4 (fee overcharge) or I-10 (slash exceeding stake) without full insolvency
- State corruption that requires external intervention or governance to fix
- Forced upgrade or forced redeployment needed
- Temporary loss of access to funds (archival not properly renewed, requiring `RestoreFootprint`)

**Examples:**
- Bounds check missing on batch registration, causing contract overflow
- Paused contract state becoming permanent (no unpause path)
- Task lifecycle state machine broken (task stuck in CLAIMED with no expiration)
- Unbonding delay bypassed, allowing immediate withdrawal
- Keeper balance deposited but not withdrawable due to state corruption

**Payout:** **$2,000 – $9,999 USD equivalent in XLM**

### Medium

**Limited impact or requiring specific conditions**

Findings that result in one or more of:
- Reputational reputation score inflation (I-7 known limitation, but exploitable beyond design intent)
- Griefing with significant but not permanent cost to an attacker (e.g., registering spam tasks that can be cancelled, incurring tx fees only to the spammer)
- Integer overflow/underflow caught by overflow checks but revealing a logic flaw
- Incorrect fee accounting (minor, recoverable via governance)
- Broken assumptions in TTL renewal that could archive infrequently-used entries (but do not break contract liveness for active keepers)

**Examples:**
- Self-dealing inflates reputation beyond documented design intent
- Decay reset creates unfair advantage for certain task-execution patterns
- Fee calculation rounds incorrectly (paying 1 bps too much in edge cases)
- Task TTL renewal buggy for very long deadline extensions

**Payout:** **$500 – $1,999 USD equivalent in XLM**

### Low

**Documentation or minor process improvements**

Findings that do not directly impact safety or fund security:
- Informational findings about best practices
- Minor improvements to error messages or event clarity
- Unused code paths or dead code
- Typos in comments or documentation

**Examples:**
- Error discriminant never emitted
- Event data missing non-critical context
- Comment documenting invariant differs from the actual numbered invariant
- Unused struct field

**Payout:** Recognition only (credit in release notes)

---

## Payout Ranges and Discretion

Bounty payouts are at the **sole discretion** of the Soroban Keeper Network maintainers, subject to:

1. **Valid reproduction** — The report includes clear steps to reproduce or proof-of-concept code (kept confidential)
2. **Project treasury availability** — Payouts depend on available funds in the project treasury; all tiers are contingent on budget constraints
3. **Severity assessment** — Findings may fall between tiers; maintainers may adjust payout within the tier range or propose a split tier
4. **First to report** — In the case of simultaneous reports, the first valid report (by timestamp) receives priority; duplicates are acknowledged but receive no separate bounty
5. **Researcher cooperation** — Researchers who actively assist in fix verification or further refinement may receive recognition or discretionary bonuses

Payouts are made in **XLM** (Stellar Lumens) at the **Stellar Development Foundation's recommended exchange rate** at the time of payment, or in another asset mutually agreed upon between the researcher and maintainers.

---

## Responsible Disclosure Process

### Reporting

1. **Email your report to:** `security@soroban-keeper.network`
   - *Until the domain is registered, contact `@Andreschuks101` on GitHub with subject line `[SECURITY] Keeper Network`*

2. **Include in your report:**
   - Description of the vulnerability and affected component(s)
   - Steps to reproduce (or proof-of-concept code kept confidential)
   - Concrete impact (funds at risk, DoS, privilege escalation, state corruption)
   - Suggested severity tier (critical / high / medium / low)
   - Whether you want credit in the release notes (optional anonymity)
   - Any prior disclosure (to other projects, advisors, etc.)

3. **Do not:**
   - Open a public GitHub issue, pull request, or discussion
   - Disclose the vulnerability on Twitter, forums, or other public channels
   - Share proof-of-concept code publicly
   - Test the vulnerability on a production network with real value at stake

### Response Timeline

| Milestone | Timeline |
|-----------|----------|
| **Acknowledgment** | Within **24 hours** of initial report |
| **Triage** | Within **3 business days** — assess severity and validity |
| **Patch for critical** | Within **7 days** of confirmed critical finding |
| **Patch for high** | Within **14 days** of confirmed high finding |
| **Patch for medium/low** | Within **30 days** of confirmed finding |
| **Public disclosure** | Minimum **90-day embargo** for critical issues; coordinates with researcher |

### Disclosure Agreement

- Researchers agree to **not disclose** the vulnerability publicly until a fix is released and users have had reasonable time to upgrade (minimum **90 days** for critical, **30 days** for high)
- Maintainers commit to **timely patching** and will notify the researcher of the planned disclosure date
- If maintainers cannot patch within the above timelines, researchers may disclose after good-faith coordination (e.g., extended timeline if a large protocol upgrade is in progress)
- Researchers may publish a detailed writeup **after public disclosure**, crediting the Soroban Keeper Network and noting the embargo period

### Credit & Recognition

- All valid vulnerability reports receive **public credit** in the release notes and GitHub security advisory (unless anonymity is requested)
- Researchers are welcome to submit a **pull request** describing the fix (for transparency and additional credit)
- Significant findings may be highlighted in blog posts, security retrospectives, or community calls

---

## Safe Harbor

The Soroban Keeper Network commits to the following safe-harbor protections for security researchers conducting good-faith vulnerability research:

1. **No legal action** — We will not pursue legal action against researchers who:
   - Report vulnerabilities responsibly under this program
   - Do not access production networks or accounts without explicit permission
   - Do not disclose findings publicly before the embargo period

2. **No account suspension** — Testnet accounts or faucet-funded accounts used for security research will not be suspended or rate-limited due to legitimate testing, provided the researcher identifies themselves as conducting security research

3. **Cooperation with law enforcement** — If law enforcement requests information about a researcher, we will:
   - Notify the researcher before complying (unless legally prohibited)
   - Not voluntarily disclose researcher identity without their consent
   - Limit disclosure to the minimum legally required

---

## Known Limitations & Accepted Risk

The program acknowledges the following trade-offs and accepted risks, which do **not** qualify for bounty:

1. **No on-chain execution verification (MVP)** — The registry credits rewards based on submitted proof bytes. A dishonest keeper could submit fake proof. Mitigation: Phase 2 adds optional on-chain verifier callbacks.

2. **Admin trust model** — The admin can pause the contract and upgrade the WASM. This is intentional for MVP; Phase 2 replaces admin with governance.

3. **Oracle-less deadline enforcement** — Deadlines are compared against `env.ledger().timestamp()`, which is set by Stellar validators. This is an accepted trust assumption on Stellar consensus.

4. **Reputation known limitations** — Per `docs/REPUTATION_SECURITY_REVIEW.md`, known limitations include self-dealing inflation at no cost, decay reset on any action, and an eligibility floor. These are design trade-offs, not bugs.

5. **Keeper balance TTL asymmetry** — `KeeperReward(addr)` entries are only renewed on write (execution or withdrawal), not read. A keeper with one executed task and no subsequent withdrawals may see archival after the full TTL. Entry is not lost, only inaccessible until restored via `RestoreFootprint`. This is an accepted design trade-off.

---

## Audit Status

| Date | Auditor | Scope | Status |
|------|---------|-------|--------|
| Q4 2026 (planned) | TBD | `keeper-registry` v1.0 | Pending |

Pre-audit internal reviews are tracked in GitHub Issues with the `security` label. This bug bounty program will be updated following external audit completion.

---

## Questions?

If you have questions about scope, severity, or the reporting process, email `security@soroban-keeper.network` or open a public discussion in GitHub Discussions (but **do not include specific vulnerability details**). We are happy to clarify whether a finding is in-scope before you begin research.

Thank you for helping secure the Soroban Keeper Network.
