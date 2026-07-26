---
title: "docs(architecture): write down the money invariants the contract is required to hold"
labels: [docs, security, intermediate]
epic: E19
wave: 1
depends_on: []
---

## Summary

The contract's safety rests on a small number of invariants about where funds can go. They are enforced across several functions and stated nowhere. Anyone reviewing a change has to reconstruct them from the code each time.

## Why this is the highest-leverage documentation in the repository

Almost every serious finding in this backlog is an invariant violation:

- The CEI ordering issues break "the contract never pays out twice for one obligation".
- The TTL-versus-deadline issue breaks "every escrowed reward is recoverable by someone".
- The sweep accumulator exists to enforce "the admin can only remove protocol fees".

Each was found by reading code and reasoning about what should be true. Written down, they become a checklist a reviewer can apply in minutes, and a specification the fuzzing and property-testing work can encode directly.

The README has a Security Considerations section, but it lists *mechanisms* — CEI, auth on mutations, overflow checks — rather than the properties those mechanisms are supposed to produce. Mechanisms are how; invariants are what. A reviewer needs the what, because that is what a change can break.

It is also demonstrably not sufficient as-is: the README asserts "CEI pattern throughout", and two functions do not follow it.

## Expected behaviour

`docs/ARCHITECTURE.md` gains a section stating each invariant precisely, why it matters, what enforces it, and how it could break.

## The invariants to document

Work from the code, not from this list — but these are the ones that matter:

**Solvency.** The registry's token balance always equals open task escrow plus credited keeper balances plus accrued fees. Every other invariant is in service of this one.

**Escrow recoverability.** Every escrowed reward has at least one reachable path back out — to the owner via cancel or expire, or to a keeper via execute and withdraw. No state strands funds.

**Single payout.** Each task's reward is paid out exactly once. Not zero times, not twice.

**Fee bounding.** The protocol never takes more than `fee_bps` of a reward, and the admin can never withdraw more than has accrued. Note the rounding: the fee is floored, so the protocol may take marginally *less*.

**Escrow isolation.** Admin functions cannot touch task escrow or credited keeper balances. `sweep_fees` is bounded by the `FeesAccrued` accumulator specifically to enforce this.

**Withdrawal liveness.** A keeper's credited balance is always withdrawable, including while the contract is paused. This is the promise that makes pausing acceptable.

**Monotonic task ids.** Ids are unique and never reused, so an external reference to a task id is stable forever.

For each: state it precisely enough to be testable, name the code that enforces it, and describe a concrete change that would break it. That last part is what makes the section useful during review rather than merely tidy.

## Suggested approach

One subsection per invariant, in a consistent shape:

```markdown
### I-3: A task's reward is paid out exactly once

**Statement.** For any task, the sum of all transfers and credits attributable
to its reward equals the reward exactly, across its whole lifetime.

**Why.** Paying twice makes the contract insolvent at the expense of other
users. Paying zero times strands the owner's funds.

**Enforced by.** The status guard at the top of each terminal transition,
combined with the status write preceding the token transfer.

**Breaks if.** A transfer is moved before its status write; a terminal status
is added to an accepting `match` arm; a new payout path skips the guard.
```

Number them, so review comments and test names can cite `I-3` rather than paraphrasing.

Cross-reference from the README security section rather than duplicating — the duplication problem already exists elsewhere in this repository's docs and should not be extended.

Where an invariant is currently violated by an open bug, say so and link the issue. A document claiming properties the code does not have is worse than no document; this section's credibility depends on being honest about the gaps on the day it is written.

## Acceptance criteria

- [ ] `docs/ARCHITECTURE.md` has a numbered invariants section.
- [ ] Each invariant has a statement, rationale, enforcing code, and a breaking-change description.
- [ ] Statements are precise enough to be encoded as test assertions.
- [ ] Known violations are named and linked to their issues.
- [ ] The README security section links here rather than restating.
- [ ] CONTRIBUTING points reviewers at the section for changes touching fund movement.

## Files

- `docs/ARCHITECTURE.md`
- `README.md`
- `CONTRIBUTING.md`

## Notes

This is the specification the property-based testing and fuzzing work will encode. Getting the statements precise here saves that work from having to invent them later.
