---
title: "test(property): assert the ttl-covers-deadline invariant now that issue 0005's fix has landed"
labels: [testing, contract, intermediate]
epic: E03
wave: 2
depends_on: [0055]
---

## Summary

Wave 1's issue 0005 (ttl shorter than deadline strands escrow) has since been fixed on main via KeeperError::InvalidTaskParams's TtlTooShort case (discriminant 16, reserved in the KeeperError enum as of the current main). Issue 0055 (escrow recoverability property test) originally had to treat this as a known-failing case with an explicit exemption. This issue removes that exemption now that the underlying bug is fixed, and adds a property specifically pinning the fix: no accepted task registration can ever have a ttl_ledgers implying an earlier storage expiry than the task's own deadline.

## Expected behaviour

A property test generating deadline and ttl_ledgers combinations and confirming: register_task rejects any combination where the persistent entry would expire before the deadline, with the TtlTooShort variant specifically, and issue 0055's escrow-recoverability property no longer needs its exemption for this case -- update that test to remove the carve-out and confirm it now passes unconditionally.

## Acceptance criteria

- [ ] New property test pins the ttl-covers-deadline invariant directly.
- [ ] Issue 0055's test is revisited and its exemption comment/skip removed, with the full property now passing.
- [ ] Confirms the exact error variant returned (TtlTooShort under the InvalidTaskParams-style numbering -- verify the exact name against current main's KeeperError enum rather than assuming).

## Files

- contracts/keeper-registry/src/test.rs
