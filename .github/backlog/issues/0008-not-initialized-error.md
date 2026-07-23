---
title: "feat(registry): add a NotInitialized error instead of panicking on an uninitialized registry"
labels: [contract, enhancement, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

If any state-changing function is called before `initialize`, the contract panics with a host error instead of returning a typed `KeeperError`. Callers get an opaque failure with no way to distinguish "this registry was never set up" from "the contract is broken".

## Current behaviour

`reward_token` panics when `RewardToken` is missing:

```rust
fn reward_token(e: &Env) -> token::Client<'_> {
    let addr: Address = e
        .storage()
        .instance()
        .get(&DataKey::RewardToken)
        .expect("not initialized");
    token::Client::new(e, &addr)
}
```

Reached from `register_task`, `increase_reward`, `cancel_task`, `expire_task`, `withdraw_rewards`, and `sweep_fees`.

`require_admin` handles the same situation correctly, returning a typed error:

```rust
let admin: Address = e
    .storage()
    .instance()
    .get(&DataKey::Admin)
    .ok_or(KeeperError::Unauthorized)?;
```

— though `Unauthorized` is itself the wrong error for "not initialized". An admin address that does not exist yet is not an authorization failure, and a caller debugging a failed `pause` call will chase the wrong problem.

## Why this matters

CONTRIBUTING is explicit:

> **No `unwrap()` in contract code** — use `ok_or(KeeperError::Foo)?` or `expect("message that explains why this is unreachable")`.

`expect("not initialized")` does not describe an unreachable state. It describes a perfectly reachable one: deploy the contract, call `register_task` before `initialize`. This is not hypothetical — a deploy script that fails between the deploy and initialize steps leaves the contract in exactly this state.

A panic also loses information. `Result<_, KeeperError>` surfaces to clients as a structured contract error they can match on; a host panic surfaces as a generic invocation failure.

## Expected behaviour

Every entry point that requires initialization returns `KeeperError::NotInitialized` when it has not happened. No entry point panics for this reason.

## Suggested approach

Add the variant — appended, not inserted, since the discriminants are part of the ABI and renumbering existing variants would break every deployed client:

```rust
pub enum KeeperError {
    // ... existing variants keep their numbers ...
    NoRewardsAvailable = 13,
    /// A function requiring configured state was called before `initialize`.
    NotInitialized = 14,
}
```

Convert the helper to return a `Result`:

```rust
fn reward_token(e: &Env) -> Result<token::Client<'_>, KeeperError> {
    let addr: Address = e
        .storage()
        .instance()
        .get(&DataKey::RewardToken)
        .ok_or(KeeperError::NotInitialized)?;
    Ok(token::Client::new(e, &addr))
}
```

and propagate with `?` at each call site. Also change `require_admin` to return `NotInitialized` rather than `Unauthorized` when the admin key is absent — but check the existing tests first, since at least one asserts on the current error for an uninitialized call.

Decide what the read-only views should do. `admin()` already returns `Option<Address>`, which is fine. `task_count()`, `is_paused()`, and `fees_accrued()` return defaults, which is also defensible for a view. State the policy in a comment so the next person does not "fix" it in the other direction.

## Acceptance criteria

- [ ] `KeeperError::NotInitialized` exists with a new, appended discriminant.
- [ ] No existing error discriminant changes value.
- [ ] `reward_token` returns a `Result` and no longer calls `expect`.
- [ ] Every state-changing entry point returns `NotInitialized` when called before `initialize`, covered by a test per entry point.
- [ ] `require_admin` distinguishes "no admin configured" from "wrong caller".
- [ ] The chosen behaviour for read-only views is documented in a comment.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
