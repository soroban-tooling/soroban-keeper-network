---
title: "chore(backlog): audit wave 2's issue cross-references for accuracy after publication"
labels: [tooling, good-first-issue]
epic: E05
wave: 2
depends_on: []
---

## Summary

Wave 2's 150 issue files reference each other extensively by their 00NN filename numbers in prose (depends_on front matter is more reliable, but body text also cross-references by number). Once all 150 are published and some have been picked up, edited, or closed as not-applicable (per the several feasibility-study issues in epic E05 that may conclude "don't build"), a pass confirming those in-body references still point at the right thing is worth doing once, rather than each reader discovering a stale reference independently.

## Expected behaviour

A review pass over every issue file in the 0051-0150 range checking that numbered cross-references in the body text (not just depends_on) still describe the referenced issue accurately, updating or removing any that have drifted.

## Acceptance criteria

- [ ] Every in-body issue-number reference in the 0051-0150 range is checked against the actual current title/content of the referenced file.
- [ ] Drifted references are corrected, not just flagged.

## Files

- .github/backlog/issues/*.md
