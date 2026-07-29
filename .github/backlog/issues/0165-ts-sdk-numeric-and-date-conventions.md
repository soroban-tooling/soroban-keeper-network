---
title: "design(sdk-ts): pin the SDK-wide conventions for i128/u64 numbers and Unix-timestamp fields"
labels: [docs, intermediate]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

Several methods across this epic (issues 0154, 0155, 0160, 0163) touch either large integers (`i128` rewards and balances, which can exceed `Number.MAX_SAFE_INTEGER`) or Unix-second timestamps (`deadline`, `new_deadline`). Rather than let each method's issue decide independently and produce an inconsistent API, this issue pins the convention once, early, for the rest of the epic to follow.

## Decisions to make

- **Large integers** (`i128 reward`, `i128 balance`, `u64 taskId`, `u64 deadline` as a raw value): `bigint` end-to-end is the safe default given `i128` can exceed safe-integer range, but confirm whether `@stellar/stellar-sdk`'s own APIs (`nativeToScVal`, `scValToNative`) already return/expect `bigint` for these types, so the SDK's convention matches its own dependency rather than adding unnecessary conversion.
- **Timestamps**: accept both a `Date` and a Unix-seconds `number`/`bigint` at the API boundary (convert internally), or pick exactly one and force callers to convert themselves? Consider what's more ergonomic for the two obvious consumer types this epic targets — a Node script (comfortable with `Date`) and a keeper bot doing arithmetic against `Date.now()` (per the existing `examples/keeper-bot` pattern, which uses `Math.floor(Date.now() / 1000)`).

## Expected output

A short `packages/sdk-ts/CONVENTIONS.md` stating both decisions, referenced (not restated) by every method issue in this epic.

## Acceptance criteria

- [ ] Both conventions are decided and justified against the underlying SDK dependency's own behavior, not chosen in a vacuum.
- [ ] Documented in one place all other issues can point to.
- [ ] Issues 0154, 0155, 0160, and 0163 (already drafted, possibly ahead of this one depending on pickup order) are revisited to confirm their eventual implementation matches this decision.

## Files

- packages/sdk-ts/CONVENTIONS.md
