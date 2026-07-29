---
title: "feat(sdk-ts): admin methods -- pause, unpause, setFeeBps, setMinReward"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Typed wrappers for the four single-auth admin controls, grouped together since they share the same shape (admin signs, one value changes, one event fires).

## Expected behaviour

`client.pause({ admin })`, `client.unpause({ admin })`, `client.setFeeBps({ admin, newBps })`, `client.setMinReward({ admin, minReward })`, each rejecting `Unauthorized` (wrong admin) and `NotInitialized` (uninitialized registry) as distinct typed outcomes, and `setFeeBps` additionally rejecting `InvalidFeeBps` for values above 10,000 with a client-side pre-check to save the round trip.

## Acceptance criteria

- [ ] All four methods implemented with consistent typed-error handling.
- [ ] `setFeeBps`'s client-side bound check is tested against the exact boundary (10,000 accepted, 10,001 rejected before any network call).

## Files

- packages/sdk-ts/src/methods/admin.ts
