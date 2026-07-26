---
title: "test(registry): assert transfer_admin genuinely requires the incoming admin's authorization"
labels: [testing, contract, security, intermediate]
epic: E02
wave: 1
depends_on: []
---

## Summary

`transfer_admin` calls `new_admin.require_auth()` so the admin role cannot be pushed onto an address that has not consented. Every existing test runs under `env.mock_all_auths()`, which satisfies that requirement automatically — so the dual-auth property is asserted by no test at all.

## Current coverage

- `test_transfer_admin_moves_control` — asserts the new admin can act afterwards.
- `test_transfer_admin_emits_event`.

Both call `env.mock_all_auths()`, which makes every `require_auth()` in the invocation succeed regardless of who signed. Under that setup, deleting the `new_admin.require_auth()` line from the contract would not fail a single test.

## Why this specific property matters

The contract documents it as a deliberate safety property:

> Both the current admin and the incoming admin must authorize, so the role can never be transferred to an address that has not consented to take it (no accidental lock-out).

That is the only thing standing between a fat-fingered address and a permanently un-administrable registry. Transfer the admin role to an address nobody controls and there is no recovery: `pause`, `upgrade`, `set_fee_bps`, and `sweep_fees` are all gated on an admin that does not exist. The contract keeps escrowing and paying out — keepers can still withdraw — but it can never be paused, upgraded, or have its fees swept again.

A safety property that no test exercises is a comment, not a property.

## Expected behaviour

A test drives `transfer_admin` with real authorization scoped to the current admin only, and asserts the call fails.

## Suggested approach

Use `env.mock_auths()` with an explicit list rather than `mock_all_auths()`, so exactly one of the two required authorizations is present:

```rust
use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

// Authorize only the current admin. The incoming admin has not consented.
env.mock_auths(&[MockAuth {
    address: &admin,
    invoke: &MockAuthInvoke {
        contract: &registry_id,
        fn_name: "transfer_admin",
        args: (admin.clone(), new_admin.clone()).into_val(&env),
        sub_invokes: &[],
    },
}]);

let result = client.try_transfer_admin(&admin, &new_admin);
assert!(result.is_err(), "transfer must fail without the incoming admin's auth");
```

Then assert the admin did **not** change — `client.admin()` still returns the original — which is the consequence that actually matters.

Add the mirror case: authorize only the incoming admin and assert the transfer fails because the current admin did not sign. That covers the other half of the dual requirement.

Finally, add a positive test with both authorizations explicitly mocked, to prove the test harness is capable of making the call succeed. Without it, a reviewer cannot distinguish "the auth check works" from "the mock setup is wrong and everything fails".

That third test is the one people forget, and it is what makes the other two trustworthy.

## Acceptance criteria

- [ ] A test authorizes only the outgoing admin and asserts the transfer fails and the admin is unchanged.
- [ ] A test authorizes only the incoming admin and asserts the transfer fails.
- [ ] A test authorizes both explicitly and asserts the transfer succeeds.
- [ ] None of the three uses `mock_all_auths()`.
- [ ] A comment explains why these tests deliberately avoid `mock_all_auths`, so nobody "simplifies" them later.

## Files

- `contracts/keeper-registry/src/test.rs`

## References

- [Soroban testing: authorization](https://developers.stellar.org/docs/build/guides/testing) — `mock_auths` versus `mock_all_auths`.

## Notes

Once this pattern exists, the same treatment is worth applying to other auth-sensitive paths — `execute_task`'s claimer check, `cancel_task`'s owner check. Open follow-up issues rather than expanding this one.
