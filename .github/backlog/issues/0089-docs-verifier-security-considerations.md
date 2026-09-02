---
title: "docs(security): write the security considerations section for third-party verifiers"
labels: [docs, security, intermediate]
epic: E04
wave: 2
depends_on: [0074, 0075, 0076]
---

## Summary

Attaching a verifier means the registry now executes arbitrary code chosen by a task owner, on a path that gates whether a keeper gets paid. That's a meaningfully different trust and threat model than the base MVP, and deserves its own dedicated write-up rather than being folded into the general integration guide (0088), which is aimed at "how do I use this" rather than "what could go wrong."

## Expected behaviour

A security-considerations section (in `docs/VERIFIER_DESIGN.md` or a dedicated doc, cross-referenced from the main README's Security Considerations section per the pattern issue 0050 established) covering:
- The griefing vector 0082 protects against, and why the protection is scoped the way it is.
- The panic-isolation findings from 0075 and what they mean for a keeper's risk when claiming a verifier-gated task.
- The resource-budget cost transfer from 0076 — a keeper claiming a verifier-gated task is trusting the owner didn't attach something abusively expensive.
- Whether a malicious verifier could ever be used to *steal* funds (as opposed to merely griefing availability) — **see I-8 in `docs/ARCHITECTURE.md`** for the authoritative statement. I-8 walks through the call sequence in `execute_task` and confirms the verifier call happens with no ability to reenter and no access to move funds itself, given it's called before the reward-crediting step.

## Acceptance criteria

- [ ] Each threat above is named, and either mitigated-and-cited or accepted-and-justified.
- [ ] Explicitly confirms (with reasoning, not assertion) that a verifier cannot move funds itself, only gate whether the registry's own crediting logic runs.
- [ ] Linked from README's Security Considerations section.

## Files

- `docs/VERIFIER_DESIGN.md`
- `README.md`
