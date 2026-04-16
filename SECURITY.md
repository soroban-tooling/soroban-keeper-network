# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main` (latest) | Yes |
| `develop` | No (pre-release) |
| All others | No |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities via GitHub Issues, Pull Requests, or Discussions.** Public disclosure before a fix is available puts all users at risk.

### Responsible Disclosure Process

1. **Email** your report to: `security@soroban-keeper.network`  
   *(Until the domain is registered, DM `@arandomogg` on GitHub with subject line: `[SECURITY] Keeper Network`)*

2. **Include** in your report:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact (funds at risk? DoS? privilege escalation?)
   - Your suggested severity (critical / high / medium / low)
   - Any proof-of-concept code (kept confidential)
   - Whether you want to be credited in the fix announcement

3. **We will respond** within **24 hours** acknowledging receipt.

4. **Timeline**:
   - Critical (funds at direct risk): patch within **7 days**
   - High: patch within **14 days**
   - Medium/Low: patch within **30 days**

5. **Disclosure**: we will coordinate a public disclosure date with you. We request a minimum **90-day embargo** for critical issues to allow users to upgrade.

6. **Credit**: security researchers who report valid vulnerabilities will be credited in the release notes (unless they prefer anonymity).

## Scope

### In Scope

- `contracts/keeper-registry/` — all on-chain logic
- Reward escrow and distribution logic
- Authentication and authorization bypass
- Reentrancy attacks
- Storage collision or poisoning
- Integer overflow/underflow that leads to fund loss
- Upgrade mechanism abuse
- Event spoofing or manipulation

### Out of Scope

- Issues in dependencies that are already publicly disclosed (report upstream)
- Theoretical attacks with no practical exploit
- Spam / griefing that only affects the attacker economically
- The off-chain keeper bot example (`examples/keeper-bot/`) — this is illustrative code, not production infrastructure

## Smart Contract Security Model

The KeeperRegistry contract follows these security principles:

- **Checks-Effects-Interactions (CEI)** — all state mutations happen before token transfers
- **Auth gating** — every write function requires `address.require_auth()`
- **No re-entrancy via Soroban's synchronous execution model** — Soroban does not support cross-contract callbacks that could re-enter; however, we follow CEI regardless
- **Bounded iteration** — no loops over unbounded collections in storage
- **Overflow protection** — `overflow-checks = true` in Cargo profile + `checked_*` arithmetic in hot paths
- **Principle of least privilege** — keepers can only execute tasks they have claimed; admin cannot steal escrowed task rewards

## Known Limitations (by Design)

1. **No on-chain execution verification (MVP)** — The registry credits rewards to keepers who submit any proof bytes. A dishonest keeper could claim-and-submit-fake-proof. Mitigation: Phase 2 adds an optional on-chain verifier callback that target protocols can implement.

2. **Admin trust** — The admin can pause the contract and upgrade the WASM. This is intentional for the MVP. Phase 2 will replace admin with a governance contract requiring token-holder votes.

3. **Oracle-less deadline enforcement** — Deadlines are compared against `env.ledger().timestamp()` which is set by the Stellar consensus network. This is a trust assumption on the Stellar validator set (acceptable for this use case).

## Bug Bounty

A formal bug bounty program will be announced after the first production deployment and audit. Until then, we offer:

- **Critical bugs** (direct fund loss): up to **$5,000 USD** equivalent in XLM (at maintainer discretion, subject to project treasury availability)
- **High bugs**: public credit + potential discretionary reward
- **Medium/Low bugs**: public credit in release notes

## Audit Status

| Date | Auditor | Scope | Report |
|------|---------|-------|--------|
| Planned Q4 2026 | TBD | `keeper-registry` v1.0 | TBD |

Pre-audit internal reviews are tracked in GitHub Issues with the `security` label.
