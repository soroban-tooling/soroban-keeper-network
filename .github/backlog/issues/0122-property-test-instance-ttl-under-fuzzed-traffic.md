---
title: "test(property): confirm instance TTL never lapses under randomized realistic call sequences"
labels: [testing, contract, intermediate]
epic: E03
wave: 2
depends_on: [0061]
---

## Summary

Wave 1's issue 0015 fixed instance-storage TTL renewal (bump_instance called from every mutating entry point) with a hand-written test advancing ledgers past the original bug's window. This issue generalizes that into a property: for any randomized sequence of mutating calls with randomized gaps (in ledger count) between them, does the instance ever actually lapse, given the documented INSTANCE_BUMP_THRESHOLD/INSTANCE_BUMP_LEDGERS constants?

## Expected behaviour

Using the model-checking harness from issue 0061 (or a standalone property if that harness is not ready), generate sequences of mutating calls separated by randomized ledger advances up to just under INSTANCE_BUMP_LEDGERS, and confirm the instance TTL, queried via the deployer testutils, never drops to zero as long as at least one mutating call happens within every INSTANCE_BUMP_LEDGERS window. Separately, confirm the documented failure mode (a fully idle registry for longer than the bump window does eventually archive) actually happens as documented -- proving both halves of the tradeoff ARCHITECTURE.md describes.

## Acceptance criteria

- [ ] Property confirms liveness under realistic (bounded-gap) traffic.
- [ ] A separate, explicit test confirms the accepted idle-archival failure mode actually occurs as documented, not just assumed.
- [ ] References the TTL section of docs/ARCHITECTURE.md added by issue 0015.

## Files

- contracts/keeper-registry/src/test.rs
