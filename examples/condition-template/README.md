# Condition Contract Template

A copyable starter template for writing custom task conditions for Soroban Keeper Network (Epic E10).

## Overview

Task conditions allow task creators to register a pre-claim gate on their tasks. When a keeper attempts to call `claim_task`, the Keeper Registry invokes the attached condition contract's `is_met(env, task_id)` method. If the condition returns `false` or panics, the claim is rejected with `KeeperError::ConditionNotMet`, leaving the task in `Pending` status without any state mutation.

For full architectural details, see the official integration guide:
- [Task Conditions Design Guide](../../docs/TASK_CONDITIONS_DESIGN.md)
- [Keeper Bot Condition Requirements](../../docs/KEEPER_BOT_CONDITION_REQUIREMENTS.md)

## Interface

Condition contracts must implement `ITaskCondition`:

```rust
#[contractclient(name = "TaskConditionClient")]
pub trait ITaskCondition {
    /// Returns `true` if the condition for `task_id` is currently satisfied, `false` otherwise.
    /// Must never panic on a merely false condition — return `false`.
    fn is_met(env: Env, task_id: u64) -> bool;
}
```

## Budget Limits & Resource Model

In Soroban, sub-contract calls run synchronously within the parent transaction's execution context:
1. **No Sub-call Gas Cap**: Soroban currently provides no mechanism for the caller to restrict gas consumed by a child invocation.
2. **Caller Bears Full Cost**: The keeper executing `claim_task` pays for all CPU instructions and RAM consumed by the condition check.
3. **Pre-Claim Simulation**: Keepers and keeper bots must always simulate `TaskConditionClient::is_met` before submitting a claim on-chain to verify:
   - The condition evaluates to `true`.
   - The execution resource cost is within acceptable profit margins relative to the task's reward bounty.

## Running Tests

### TypeScript
```bash
npm test --prefix examples/condition-template
```

### Rust
```bash
cargo test --manifest-path examples/condition-template/contracts/Cargo.toml
```
