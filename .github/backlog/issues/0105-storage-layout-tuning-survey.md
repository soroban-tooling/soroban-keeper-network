---
title: "design(registry): survey the Task struct for storage-layout tuning opportunities"
labels: [contract, docs, advanced]
epic: E05
wave: 2
depends_on: []
---

## Summary

The Task struct has grown since the MVP shipped -- lock/claim tracking fields, and potentially a verifier field from epic E04 -- and every field is charged against storage rent and the resource cost of every save_task call. This issue is a survey, not a commitment to change anything: does the current layout have avoidable cost, and if so, where.

## Questions to answer

- Are any fields storing redundant information that could be derived instead (for example, is claim_ledger ever needed once lock_expired has already been evaluated once, or could it be recomputed from an event log instead of stored)?
- Would splitting Task into a "hot" struct (status, claimer, deadline -- read on almost every call) and a "cold" struct (calldata, original registration parameters -- read rarely after registration) reduce the typical read/write cost, given Soroban's storage read/write pricing model?
- Does the verifier field from E04, once it exists, belong on Task at all, or would a separate DataKey::TaskVerifier(task_id) entry (read only by execute_task, not by every other function that loads a task) be cheaper for the common case where no verifier is attached?

## Expected output

A short document (docs/STORAGE_LAYOUT.md or a section in ARCHITECTURE.md) with findings and, if any change looks worthwhile, a scoped follow-up issue with its own migration-safety analysis -- do not implement a layout change directly from this issue.

## Acceptance criteria

- [ ] Each question above is answered with reasoning grounded in Soroban's actual storage cost model, not assumption.
- [ ] If a change is recommended, it is filed as a separate issue with explicit migration considerations for already-persisted Task entries.
- [ ] If no change is worthwhile, that conclusion is recorded too -- a survey that finds nothing is still a useful, closed question.

## Files

- docs/STORAGE_LAYOUT.md
