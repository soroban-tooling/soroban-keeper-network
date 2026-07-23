---
title: "fix(registry): instance storage TTL is extended only in initialize and can expire on a live contract"
labels: [contract, bug, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

`extend_ttl` is called on instance storage exactly once, inside `initialize`. Every other function reads and writes instance storage without renewing it. On a long-lived contract the instance entry — which holds the admin, the reward token, the pause flag, the fee, and the task counter — can be archived.

## Current behaviour

The only instance TTL extension in the contract:

```rust
// initialize
e.storage().instance().extend_ttl(100_000, 100_000);
```

Meanwhile persistent entries *are* renewed on write:

```rust
// save_task
e.storage().persistent().extend_ttl(
    &DataKey::Task(task_id),
    task.ttl_ledgers,
    task.ttl_ledgers,
);

// credit_keeper
e.storage().persistent().extend_ttl(&key, 100_000, 100_000);
```

So per-task and per-keeper data keeps itself alive, but the contract's own configuration does not.

## Why this matters

100,000 ledgers is roughly 5–6 days at Stellar's ~5 second ledger close time. After that window, if nothing has extended it, the instance entry becomes archived and the contract is unusable until someone restores it — every entry point reads instance storage.

The counter-argument is that Soroban bumps instance TTL implicitly on access in some configurations, and that an active contract is being accessed constantly. Do not rely on that: it is network configuration rather than a contract-level guarantee, and it makes the contract's liveness depend on external traffic. A registry with no tasks registered for a week is exactly the situation where nobody is accessing it — and exactly the situation where it must still work when someone finally does.

Note also that `credit_keeper` renews its own entry only when a keeper is *credited*. A keeper who executed one task and never came back has a balance entry that stops being renewed. If the entry is archived, `keeper_balance` reads `unwrap_or(0)` and reports zero for a balance the keeper is genuinely owed. That is the same class of bug with a worse outcome, and it is worth covering in the same PR.

## Expected behaviour

Instance storage TTL is renewed on every state-mutating entry point, so an actively used contract never approaches archival. Keeper balance entries are renewed on read as well as on write, or the archival behaviour is explicitly documented.

## Suggested approach

Introduce named constants — the bare `100_000` appears three times with no explanation — and a small helper called at the top of each mutating function:

```rust
/// Ledgers of instance-storage lifetime requested on each state change.
/// At ~5s per ledger this is roughly 6 days; renewing on every mutation means
/// a contract in active use never approaches archival.
const INSTANCE_BUMP_LEDGERS: u32 = 100_000;
/// Renew when fewer than this many ledgers remain, so a bump is not paid for
/// on every single call.
const INSTANCE_BUMP_THRESHOLD: u32 = 50_000;

fn bump_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_LEDGERS);
}
```

Using a threshold below the bump amount means the extension is a no-op most of the time and only costs resources when the entry is genuinely approaching expiry.

Decide deliberately whether read-only views should also bump. The argument against: views are simulated by clients for free and should not have side effects. The argument for: it keeps the contract alive under read traffic. State the choice in a comment.

## Acceptance criteria

- [ ] All TTL magic numbers are replaced by named constants with doc comments.
- [ ] Every state-mutating entry point renews instance TTL.
- [ ] A threshold is used so renewal is not paid on every call.
- [ ] Keeper balance TTL renewal is addressed, either by renewing more aggressively or by documenting the archival behaviour and its consequence for `keeper_balance`.
- [ ] A test advances the ledger sequence well past the initial TTL, performs a mutation partway through, and asserts the contract is still usable.
- [ ] `docs/ARCHITECTURE.md` describes the TTL strategy for each storage class.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `docs/ARCHITECTURE.md`

## References

- [Soroban state archival](https://developers.stellar.org/docs/build/guides/archival)
