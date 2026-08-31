---
title: "feat(rust-sdk): typed wrappers for the admin entry points"
labels: [rust-sdk, enhancement, intermediate]
epic: E13
wave: 3
depends_on: [0198, 0200]
---

## Summary

Adds the admin-only entry points to the Rust SDK client: initialize, pause, unpause, set_fee_bps, set_min_reward, transfer_admin, upgrade, and sweep_fees.

## Expected behaviour

One method per entry point, matching admin.rs's actual signatures. transfer_admin in particular requires two authorizations (the current admin and the incoming admin) at the contract level; the SDK method should accept both as explicit signing keys or authorization callbacks rather than silently only signing with one and letting the transaction fail on submission with an opaque auth error.

## Suggested approach

Do not add a higher-level "AdminClient" wrapper type distinct from the main client in this issue. Keep every entry point, admin or not, on one client struct, consistent with how the contract itself has no separate admin interface. A convenience wrapper can be proposed later as its own issue if real usage shows it's wanted.

## Acceptance criteria

- [ ] All eight admin methods implemented with the contract's exact argument types.
- [ ] transfer_admin's dual-auth requirement is documented on the method and exercised by a test that supplies both signers.
- [ ] A test confirms set_fee_bps rejects a value above 10,000 with the correct typed error, matching the contract's InvalidFeeBps.
- [ ] upgrade's BytesN<32> wasm hash argument is typed correctly, not accepted as a raw byte slice that could be the wrong length.

## Files

- rust-sdk/src/client.rs
- rust-sdk/tests/admin.rs
