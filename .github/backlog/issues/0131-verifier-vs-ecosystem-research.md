---
title: "research: survey how comparable keeper/automation networks handle execution verification"
labels: [docs, advanced]
epic: E04
wave: 2
depends_on: [0071]
---

## Summary

This protocol is not the first permissionless keeper network to face the "how do we know the keeper actually did the work" problem. Before epic E04's design (issue 0071) is treated as final, it is worth a deliberate look at how comparable systems in the broader automation-network space have approached the same problem, to confirm this design either matches proven patterns or deviates from them for a stated, good reason.

## Expected behaviour

A short research document summarizing at least two or three comparable approaches (the specific systems are left to the researcher to identify and are not named here, since this document should not launder assumptions about what "the industry standard" is without the researcher actually verifying claims against primary sources) and comparing each against this repository's proof-submission-plus-optional-verifier design, noting where they agree and where this design intentionally differs.

## Acceptance criteria

- [ ] Every comparison claim is sourced (a link to actual documentation or code of the system being compared, not a general impression).
- [ ] At least one point of genuine difference from this design is identified and either validates or challenges a decision already made in issue 0071 -- a survey that only confirms existing choices without finding anything to question was not done critically enough.
- [ ] Findings feed back into docs/VERIFIER_DESIGN.md as a "prior art" section, not just a standalone document nobody links to.

## Files

- docs/VERIFIER_DESIGN.md
