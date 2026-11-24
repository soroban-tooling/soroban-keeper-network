# Admin Operations Guide

This guide covers every administrative entry point on `KeeperRegistry` (`contracts/keeper-registry/src/admin.rs` and `contracts/keeper-registry/src/staking.rs`): when to use it, operational risks, the exact event emitted, and how to verify the result on-chain.

All admin actions require `require_admin(&e, &admin)` (the stored `DataKey::Admin` must match `admin` and authorize the call). Admin actions are never blocked by `pause`.

## Quick Reference

| Entry Point | Purpose | Event Emitted (`(topic1, topic2)`) | Verification View |
|---|---|---|---|
| `initialize` | One-time deployment setup | `("init", "admin")` | `admin()`, `reward_token()`, `fee_bps()`, `is_paused()` |
| `pause` | Emergency circuit breaker | `("paused", "admin")` (`true`) | `is_paused()` |
| `unpause` | Resume normal operations | `("paused", "admin")` (`false`) | `is_paused()` |
| `set_fee_bps` | Update protocol fee rate | `("fee", "admin")` | `fee_bps()` |
| `set_min_reward` | Set anti-dust minimum task reward | `("minrwd", "admin")` | `min_reward()` |
| `set_min_stake` | Set minimum keeper stake to claim | `("minstk", "admin")` | `min_stake()` |
| `set_dispute_window` | Set execution dispute hold duration | `("disptwin", "admin")` | `dispute_window()` |
| `set_reputation_floor` | Set minimum keeper reputation to claim | `("repfloor", "admin")` | `reputation_floor()` |
| `sweep_fees` | Withdraw accrued protocol fees | `("sweep", "admin")` | `fees_accrued()`, token `balance(treasury)` |
| `slash` | Penalize a misbehaving keeper's stake | `("slash", "stake")` | `keeper_stake(keeper)`, `get_slash(slash_id)` |
| `resolve_slash_appeal` | Uphold or reject a keeper's slash appeal | `("resolve", "stake")` | `keeper_stake(keeper)`, `get_slash(slash_id)` |
| `resolve_execution_dispute` | Uphold or reject an owner's execution dispute | `("exresolv", "task")` | `pending_reward(keeper)`, `keeper_balance(keeper)`, `fees_accrued()` |
| `upgrade` | Replace contract WASM hash | `("upgrade", "admin")` | `version()`, contract WASM hash on ledger |
| `transfer_admin` | Hand off admin role (dual-auth) | `("admin", "xfer")` | `admin()` |

---

## 1. `initialize(admin, reward_token, fee_bps)`

- **When to use:** Once immediately after deploying a fresh `KeeperRegistry` contract.
- **Constraints:** Fails with `AlreadyInitialized` if called again; fails with `InvalidFeeBps` if `fee_bps > 10_000`.
- **Risks:** Setting the wrong `reward_token` cannot be changed later without a WASM upgrade. Double-check the SAC/token address before submitting.
- **Event to look for:** `Initialized` — topics `("init", "admin")`, data `(admin: Address, reward_token: Address, fee_bps: u32)`.
- **How to verify:** Query `admin()`, `reward_token()`, `fee_bps()`, and `is_paused()` (must be `false`).

## 2. `pause(admin)` and `unpause(admin)`

- **When to use:** Use `pause` during an active incident (discovered bug, oracle outage, or pre-upgrade freeze). Use `unpause` once the incident is resolved or an upgrade is verified.
- **Behavior (Pause Policy Matrix):**
  - **Blocked while paused:** `register_task`, `batch_register_tasks`, `claim_task`, `execute_task`, `increase_reward`, `extend_deadline`, `stake_deposit`.
  - **Allowed while paused:** `cancel_task`, `expire_task`, `withdraw_rewards`, `initiate_unbond`, `withdraw_stake`, all admin actions, and all read-only views.
- **Risks:** Keepers cannot execute already-claimed tasks while paused; if a pause lasts past task deadlines, those tasks will expire and refund owners. Pausing never freezes user funds.
- **Event to look for:** `Paused` — topics `("paused", "admin")`, data `(paused: bool,)` (`true` for `pause`, `false` for `unpause`).
- **How to verify:** Query `is_paused()`.

## 3. `set_fee_bps(admin, new_bps)`

- **When to use:** To adjust the protocol's percentage cut of task rewards (in basis points, where `100 = 1%`, `300 = 3%`, max `10_000 = 100%`).
- **Constraints:** Rejects `new_bps > 10_000` with `InvalidFeeBps`. Only affects tasks executed after the change.
- **Risks:** Setting `fee_bps` too high reduces keeper net profit and can cause bots to skip tasks. Coordinate with `min_reward` so rewards remain above the dust threshold `ceil(10_000 / fee_bps)` (see [docs/ECONOMICS.md](ECONOMICS.md)).
- **Event to look for:** `FeeUpdated` — topics `("fee", "admin")`, data `(old_bps: u32, new_bps: u32)`.
- **How to verify:** Query `fee_bps()` and confirm it equals `new_bps`.

## 4. `set_min_reward(admin, min_reward)`

- **When to use:** To prevent dust/spam task registrations and ensure tasks cover keeper gas plus protocol fees. Set to `0` to disable the floor.
- **Constraints:** Rejects `min_reward < 0` with `InvalidReward`. Only affects future registrations.
- **Risks:** Setting `min_reward` too high prices out small automation tasks. Setting it below `ceil(10_000 / fee_bps)` allows tasks that generate zero protocol fee.
- **Event to look for:** `MinRewardUpdated` — topics `("minrwd", "admin")`, data `(old_min: i128, new_min: i128)`.
- **How to verify:** Query `min_reward()` and confirm it equals `min_reward`.

## 5. `set_min_stake(admin, min_stake)`

- **When to use:** To require keepers to hold a minimum bonded stake before calling `claim_task`. Set to `0` to disable.
- **Constraints:** Rejects `min_stake < 0` with `InvalidReward`. Only affects future claims; existing claims are unaffected.
- **Risks:** Raising `min_stake` suddenly can lock out active keeper bots until they call `stake_deposit`, causing missed executions. Announce increases in advance.
- **Event to look for:** `MinStakeUpdated` — topics `("minstk", "admin")`, data `(old_min: i128, new_min: i128)`.
- **How to verify:** Query `min_stake()` and confirm it equals `min_stake`.

## 6. `set_dispute_window(admin, ledgers)`

- **When to use:** To enable or adjust the post-execution hold period during which task owners can call `dispute_execution` before a keeper's reward becomes withdrawable. Set to `0` to disable (immediate withdrawability).
- **Constraints:** Rejects `ledgers > MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS` (`86_400`, ~5 days) with `InvalidTaskParams`.
- **Risks:** A long dispute window delays keeper liquidity and requires keepers to wait until `unlock_ledger` before `withdraw_rewards` finalizes pending credits.
- **Event to look for:** `DisputeWindowUpdated` — topics `("disptwin", "admin")`, data `(old_ledgers: u32, new_ledgers: u32)`.
- **How to verify:** Query `dispute_window()` and confirm it equals `ledgers`.

## 7. `set_reputation_floor(admin, floor_bps)`

- **When to use:** To gate `claim_task` so only keepers whose decayed reputation score is at least `floor_bps` (in basis points, `0..=10_000`) may claim tasks. Set to `0` to disable.
- **Constraints:** Rejects `floor_bps > MAX_REPUTATION_FLOOR_BPS` (`10_000`) with `InvalidReputationFloor`. Only affects future claims.
- **Risks:** Setting a non-zero floor blocks brand-new keepers (whose initial score is `0`) from onboarding. Setting `10_000` blocks any keeper with even a single missed lock.
- **Event to look for:** `ReputationFloorUpdated` — topics `("repfloor", "admin")`, data `(old_floor_bps: u32, new_floor_bps: u32)`.
- **How to verify:** Query `reputation_floor()` and confirm it equals `floor_bps`.

## 8. `sweep_fees(admin, treasury, amount)`

- **When to use:** To transfer accumulated protocol fees (`FeesAccrued`) to a treasury address (such as `contracts/treasury`).
- **Constraints:** Rejects `amount <= 0` with `InvalidReward` and `amount > fees_accrued()` with `NoRewardsAvailable`. Bounded strictly by `FeesAccrued` (invariant I-5: can never touch task escrow or keeper balances).
- **Risks:** Sending to an unintended `treasury` address is irreversible. When routing to `contracts/treasury`, call `distribute()` on the treasury contract afterwards as a separate step.
- **Event to look for:** `FeesSwept` — topics `("sweep", "admin")`, data `(treasury: Address, amount: i128, remaining: i128)`.
- **How to verify:** Query `fees_accrued()` (must equal `remaining`) and check the reward token balance of `treasury`.

## 9. `slash(admin, keeper, amount, reason, treasury)`

- **When to use:** To penalize a keeper for verified misbehavior by transferring `amount` of their bonded stake to `treasury`.
- **Constraints:** `amount` must be `> 0` and `<= keeper_stake(keeper)` (invariant I-10). `reason` is a Soroban `Symbol`.
- **Risks:** Immediately transfers funds to `treasury`. The keeper has `DISPUTE_WINDOW_LEDGERS` (`51_840`, ~3 days) to call `raise_slash_appeal`. If an appeal is later upheld, the admin must supply the refund amount.
- **Event to look for:** `Slashed` — topics `("slash", "stake")`, data `(slash_id: u64, keeper: Address, amount: i128, reason: Symbol)`.
- **How to verify:** Query `keeper_stake(keeper)` (decreased by `amount`) and `get_slash(slash_id)`.

## 10. `resolve_slash_appeal(admin, slash_id, uphold_appeal)`

- **When to use:** After a slashed keeper calls `raise_slash_appeal(keeper, slash_id)`.
- **Behavior:**
  - `uphold_appeal = true`: pulls `record.amount` from `admin` back into the contract and restores it to the keeper's stake.
  - `uphold_appeal = false`: leaves the slash standing with no token transfer.
- **Risks:** Upholding requires the `admin` account to hold and authorize `record.amount` of the reward token.
- **Event to look for:** `SlashAppealResolved` — topics `("resolve", "stake")`, data `(slash_id: u64, upheld: bool)`.
- **How to verify:** Query `keeper_stake(keeper)` and `get_slash(slash_id)` (record is removed once resolved).

## 11. `resolve_execution_dispute(admin, task_id, uphold_dispute)`

- **When to use:** After a task owner calls `dispute_execution(owner, task_id)` on a task whose reward is held in `PendingCredit`.
- **Behavior:**
  - `uphold_dispute = true`: forfeits the keeper's pending `net_reward` and routes it to `FeesAccrued`.
  - `uphold_dispute = false`: clears the dispute flag so the keeper can finalize and withdraw once the window elapses.
- **Risks:** Decision is final; verify off-chain execution proof before upholding or rejecting.
- **Event to look for:** `ExecutionDisputeResolved` — topics `("exresolv", "task")`, data `(task_id: u64, upheld: bool)`.
- **How to verify:** Query `pending_reward(keeper)` and (if upheld) `fees_accrued()`.

## 12. `upgrade(admin, new_wasm_hash)`

- **When to use:** To deploy a new contract WASM binary (already installed on-chain via `stellar contract install`) while preserving contract address and storage.
- **Risks:** Incompatible storage layout changes can brick the contract. Always test the upgrade path against a testnet clone first, consider calling `pause` before upgrading, and verify `VERSION` and ABI compatibility (see [docs/CONTRACT_MIGRATIONS.md](CONTRACT_MIGRATIONS.md)).
- **Event to look for:** `Upgraded` — topics `("upgrade", "admin")`, data `(admin: Address, new_wasm_hash: BytesN<32>)` (emitted *before* the WASM swap).
- **How to verify:** Query `version()` and inspect the contract's installed WASM hash on-chain.

## 13. `transfer_admin(admin, new_admin)`

- **When to use:** To rotate admin keys, move control to a multisig, or hand off administration to `contracts/governance`.
- **Safeguard:** Requires authorization from **both** `admin` and `new_admin`, preventing accidental lockout to an unreachable address.
- **Risks:** Immediate and irreversible from the old admin's perspective once confirmed.
- **Event to look for:** `AdminTransferred` — topics `("admin", "xfer")`, data `(old_admin: Address, new_admin: Address)`. Note that `"admin"` is the *first* topic here, unlike other admin events.
- **How to verify:** Query `admin()` and confirm it returns `new_admin`.
