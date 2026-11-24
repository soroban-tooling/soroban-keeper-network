# Access Control Matrix (issue #735)

This document is the **complete authorisation and pause matrix** for every
public entry point of the two production contracts in this repository:
`contracts/keeper-registry` and `contracts/treasury`. It is written from the
code, not from intent — where an older comment disagreed with the code, the
code won and the comment was corrected (see the note on `initiate_unbond`
below).

`contracts/keeper-registry/src/test/access_control.rs` mechanically parses the
`#[contractimpl]` blocks of both crates and asserts that every `pub fn` found
there has a row in the matching matrix below. Adding an entry point without
adding a row fails `cargo test`. That test is the guarantee behind the word
"every" in this document.

## How to read the columns

- **Entry point** — the exact ABI name (the `pub fn` in a `#[contractimpl]` impl).
- **Authoriser** — who must sign. `require_admin` means `admin.require_auth()`
  plus an equality check against `DataKey::Admin`; a named role (`owner`,
  `keeper`, `caller`, `recipient`) means that specific argument authorises
  (`X.require_auth()`); "permissionless" means no signature is required.
- **While paused** — `BLOCKED` means `require_not_paused` (registry) or the
  treasury equivalent returns the paused error *before any write*. "allowed"
  means the pause flag is not consulted. Views are never gated. The standing
  rule is: **anything that opens new exposure is blocked; anything that only
  lets value flow back to whoever already owns it stays open**, so incident
  response can never become a fund freeze. Admin actions are never gated —
  pausing does not restrict the admin.
- **Checks before any write** — the guards that run before the first
  `storage().set/remove/extend_ttl` or token `transfer`. "CEI" marks an
  entry point that additionally writes its effect before the external token
  call, as a re-entrancy defence.

<!-- BEGIN REGISTRY MATRIX -->
## Keeper registry (`contracts/keeper-registry`)

| Entry point | Authoriser | While paused | Checks before any write |
| --- | --- | --- | --- |
| `initialize` | `admin`, one time only | N/A — no `Paused` key exists until this call writes it; this is the only entry point callable on an uninitialised registry | `DataKey::Admin` must be absent (`AlreadyInitialized`); `fee_bps <= 10_000`; `admin.require_auth()`. Writes `Admin`, `RewardToken`, `FeeBps`, `Paused=false`, `TaskCounter=0`, then bumps instance TTL. |
| `pause` | current admin | allowed (admin action) | `require_admin` (admin key present + auth + equality). Writes `Paused=true`. |
| `unpause` | current admin | allowed (admin action) | `require_admin`. Writes `Paused=false`. |
| `set_fee_bps` | current admin | allowed (admin action) | `require_admin`; `new_bps <= 10_000`. |
| `set_min_reward` | current admin | allowed (admin action) | `require_admin`; `min_reward >= 0`. |
| `set_reputation_floor` | current admin | allowed (admin action) | `require_admin`; `floor_bps <= MAX_REPUTATION_FLOOR_BPS`. |
| `transfer_admin` | current admin **and** incoming admin | allowed (admin action) | `require_admin`; `new_admin.require_auth()` — the role can never move to an address that did not consent. |
| `upgrade` | current admin | allowed (admin action) | `require_admin`; `Upgraded` event is emitted **before** `update_current_contract_wasm` so the audit record does not depend on the new code's semantics. |
| `sweep_fees` | current admin | allowed (admin action) | `require_admin`; `amount > 0`; `amount <= FeesAccrued`, so a sweep can never reach task escrow or keeper balances; CEI — `FeesAccrued` is debited before the token transfer. |
| `register_task` | `owner` | **BLOCKED** | `require_not_paused`; `owner.require_auth()`; `validate_task_params` (reward positive and >= min reward, deadline in the future, calldata <= `MAX_CALLDATA_LEN`, lock in `[MIN_LOCK_LEDGERS, MAX_LOCK_LEDGERS]`, TTL >= `MIN_TTL_LEDGERS` and >= deadline coverage); escrow transfer precedes the task write. |
| `batch_register_tasks` | `owner` (one auth for the whole batch) | **BLOCKED** | `require_not_paused`; `owner.require_auth()`; batch non-empty; `len <= MAX_BATCH_SIZE`; `max_total_reward > 0`; **every** entry validated and the summed reward checked against `max_total_reward` before any transfer — whole-batch atomicity. |
| `get_tasks` | **permissionless** view | allowed | `ids.len() <= MAX_BATCH_READ` (`BatchTooLarge` otherwise); otherwise read-only and positionally aligned — an unknown id yields `None` rather than failing the call; no TTL bump. |
| `get_tasks_range` | **permissionless** view | allowed | `count <= MAX_BATCH_READ`; checked addition on the last id so a range cannot wrap to low ids; otherwise read-only with the same positional `None` policy; no TTL bump. |
| `increase_reward` | task `owner` | **BLOCKED** | `require_not_paused`; `owner.require_auth()`; `additional > 0`; task exists; caller is `task.owner`; status is `Pending`/`Claimed`; escrow transfer before the reward write. |
| `extend_deadline` | task `owner` | **BLOCKED** | `require_not_paused`; `owner.require_auth()`; task exists; caller is owner; status `Pending`/`Claimed`; `new_deadline > old_deadline`. |
| `update_verifier` | task `owner` | **BLOCKED** | `require_not_paused`; `owner.require_auth()`; task exists; caller is owner; status strictly `Pending` (a claimed task's verifier cannot be swapped mid-flight). |
| `claim_task` | `keeper` (self) | **BLOCKED** | `require_not_paused`; `keeper.require_auth()`; min-stake floor if configured; task exists; deadline not passed; status `Pending`, or `Claimed` with an expired lock; reputation floor if configured; **external condition** `try_is_met(task_id)` must return `Ok(Ok(true))`. All of this precedes `record_missed_claim` and the task write. |
| `execute_task` | claiming `keeper` (self) | **BLOCKED** | `require_not_paused`; `keeper.require_auth()`; `proof.len() <= MAX_PROOF_LEN`; task exists and is `Claimed`; caller is the recorded claimer; deadline not passed; **external verifier** `try_verify(task_id, keeper, proof)` must return `Ok(Ok(true))`. All guards precede the credit/fee/reputation writes. |
| `cancel_task` | task `owner` | allowed — owner reclaiming its own escrow is liveness, not new exposure | `owner.require_auth()`; task exists; caller is owner; status `Pending`, or `Claimed` with an expired lock; CEI — status becomes `Cancelled` before the refund transfer. |
| `expire_task` | **permissionless** | allowed — permissionless fund recovery | task exists; status `Pending`/`Claimed`; deadline has passed; CEI — status becomes `Expired` before the refund transfer, so a re-entrant call cannot refund twice. |
| `withdraw_rewards` | `keeper` (self) | allowed — already-earned balance | `keeper.require_auth()`; finalise matured pending credits; balance > 0; CEI — balance is zeroed before the token transfer. |
| `stake_deposit` | `keeper` (self) | **BLOCKED** — opens new keeper exposure | `require_initialized`; `require_not_paused`; `amount > 0`; `keeper.require_auth()`; checked-add on stake; CEI — stake written and TTL extended before the token transfer. |
| `initiate_unbond` | `keeper` (self) | **BLOCKED** | `require_initialized`; `require_not_paused`; `amount > 0`; `keeper.require_auth()`; `amount <= KeeperStake`; no unbond request already pending; checked subtraction. Writes the reduced stake and the new `UnbondRequest` (both TTL-extended). See the correction note below. |
| `withdraw_stake` | `keeper` (self) | allowed — already-owned funds | `require_initialized`; `keeper.require_auth()`; request exists; `sequence >= unlock_ledger` (inclusive boundary); CEI — request removed before the token transfer. |
| `slash` | current admin | allowed (admin action) | `require_admin`; `amount > 0`; `amount <= KeeperStake + pending UnbondRequest` (unbonding is not a slash-evasion path); checked arithmetic throughout; CEI — stake, unbond, `Slash(id)` record and `SlashHistory` are all written/TTL-extended before the token transfer. |
| `set_min_stake` | current admin | allowed (admin action) | `require_admin`; `min_stake >= 0`. |
| `raise_slash_appeal` | the slashed `keeper` (self) | allowed — no value moves | `keeper.require_auth()`; record exists; caller is `record.keeper`; not already appealed; `sequence <= slash.ledger + DISPUTE_WINDOW_LEDGERS`; renews both the record TTL and the instance TTL so a slow admin cannot find an archived appeal. |
| `resolve_slash_appeal` | current admin | allowed (admin action) | `require_admin`; record exists and `appealed == true`; CEI — record removed before the optional refund transfer (an upheld appeal pulls funds **from the admin**, because `slash` already paid out). |
| `set_dispute_window` | current admin | allowed (admin action) | `require_admin`; `ledgers <= MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS` (kept below the TTL renewal window so a pending credit cannot outlive its entry). |
| `dispute_execution` | task `owner` | allowed — no value moves | `owner.require_auth()`; task exists; caller is owner; claimer present; a pending credit for this task exists; not already disputed; `sequence < credit.unlock_ledger` (closes at exactly the boundary finalisation opens). |
| `resolve_execution_dispute` | current admin | allowed (admin action) | `require_admin`; claimer present; a disputed credit exists; CEI — credit removed or unflagged before the forfeited amount accrues to `FeesAccrued`. |
| `fees_accrued` | **permissionless** view | allowed | none — read-only, no auth, no TTL bump; defaults to 0 while unset. |
| `get_task` | **permissionless** view | allowed | `load_task` — `TaskNotFound` if absent/archived. |
| `task_count` | **permissionless** view | allowed | none — returns 0 while unset. |
| `keeper_balance` | **permissionless** view | allowed | none — returns 0 while unset; deliberately does **not** renew the entry's TTL (see `docs/STORAGE_LAYOUT.md`). |
| `admin` | **permissionless** view | allowed | none — returns `None` while uninitialised. |
| `get_fee_bps` | **permissionless** view | allowed | none — falls back to `DEFAULT_FEE_BPS` (0) while unset. |
| `is_paused` | **permissionless** view | allowed | none — returns false while unset. |
| `reward_token_address` | **permissionless** view | allowed | none — returns `None` while unset. |
| `is_claimable` | **permissionless** view | allowed | `load_task` (absent → `false`); deadline not passed; status allows a claim; invokes the **external condition** `try_is_met` when one is attached. Read-only: it never writes or renews TTL. See `docs/CROSS_CONTRACT_CALLS.md` — this is a contract call made inside a view. |
| `min_reward` | **permissionless** view | allowed | none — returns 0 while unset. |
| `reputation_floor` | **permissionless** view | allowed | none — returns 0 (check disabled) while unset. |
| `keeper_reputation` | **permissionless** view | allowed | none — returns a zero record while unset; no TTL bump. |
| `effective_reputation` | **permissionless** view | allowed | none — lazily decays the stored score to the current ledger in memory only; writes nothing and renews no TTL. |
| `max_batch_size` | **permissionless** view | allowed | none — returns the compile-time `MAX_BATCH_SIZE`; no storage access. |
| `version` | **permissionless** view | allowed | none — returns the compile-time `VERSION`; no storage access. |
| `keeper_stake` | **permissionless** view | allowed | none — returns 0 while unset; no TTL renewal, like `keeper_balance`. |
| `pending_unbond` | **permissionless** view | allowed | none — returns `None` while unset. |
| `min_stake` | **permissionless** view | allowed | none — returns 0 (check disabled) while unset. |
| `get_slash` | **permissionless** view | allowed | none — returns `None` for an unknown or resolved-appeal id. |
| `slash_history` | **permissionless** view | allowed | none — returns `(0, 0)` while unset. |
| `dispute_window` | **permissionless** view | allowed | none — returns 0 (disabled) while unset. |
| `pending_reward` | **permissionless** view | allowed | none — returns an empty vector while unset; no TTL renewal. |
| `max_pending_credits` | **permissionless** view | allowed | none — returns the compile-time `MAX_PENDING_CREDITS`; no storage access. |
<!-- END REGISTRY MATRIX -->

### Correction made while writing this matrix

The pause-policy comment table in `contracts/keeper-registry/src/admin.rs`
listed `initiate_unbond` as "allowed". The code has always called
`require_not_paused` at the top of that function; that comment was stale (the
older test it points at covers only the task-lifecycle entry points, not
staking). The comment has been corrected to `BLOCKED` to match the code and
this matrix. No behaviour changed.

<!-- BEGIN TREASURY MATRIX -->
## Treasury (`contracts/treasury`)

| Entry point | Authoriser | While paused | Checks before any write |
| --- | --- | --- | --- |
| `initialize` | `admin`, one time only | N/A — no `Paused` key exists until this call writes it | `DataKey::Admin` absent (`AlreadyInitialized`); `admin.require_auth()`. Writes `Admin`, `RewardToken`, `Paused=false`, bumps instance TTL. |
| `add_recipient` | current admin | allowed (admin action) | `require_admin`; `1 <= shares_bps <= MAX_SHARES_BPS`; address not already a recipient; `len < MAX_RECIPIENTS`; after writing, the whole set is re-validated (`validate_recipient_set`) — a rejection reverts all writes. |
| `remove_recipient` | current admin | allowed (admin action) | `require_admin`; recipient present in the list; after writing, the set is re-validated. Shares are zeroed (entry kept) so crediting stops immediately, but the recipient's credited balance is untouched and remains withdrawable. |
| `update_recipient_shares` | current admin | allowed (admin action) | `require_admin`; `1 <= new_shares_bps <= MAX_SHARES_BPS`; recipient present; whole set re-validated after the write. Already-credited balances are never recomputed. |
| `pause` | current admin | allowed (admin action) | `require_admin`. Writes `Paused=true`. |
| `unpause` | current admin | allowed (admin action) | `require_admin`. Writes `Paused=false`. |
| `transfer_admin` | current admin **and** incoming admin | allowed (admin action) | `require_admin`; `new_admin.require_auth()`. |
| `upgrade` | current admin | allowed (admin action) | `require_admin`; `Upgraded` emitted before the WASM swap, matching the registry. |
| `distribute` | `caller` (permissionless — whoever funds the distribution) | **BLOCKED** — opens new recipient exposure | `require_not_paused`; `amount > 0`; `caller.require_auth()`; recipient list non-empty; total shares > 0; checked arithmetic on every share; CEI — all recipient balances and lifetime totals are credited before the token is pulled, and only the sum actually credited is transferred (floor remainder is never collected). |
| `withdraw` | `recipient` (self) | allowed — already-earned balance | `recipient.require_auth()`; balance > 0; CEI — balance zeroed before the token transfer. |
| `admin` | **permissionless** view | allowed | none — returns `None` while uninitialised. |
| `is_paused` | **permissionless** view | allowed | none — returns false while unset. |
| `reward_token_address` | **permissionless** view | allowed | none — returns `None` while unset. |
| `recipients` | **permissionless** view | allowed | none — reads the instance recipient list plus each shares entry; no TTL bump. |
| `recipient_shares` | **permissionless** view | allowed | none — returns 0 for an unregistered recipient. |
| `recipient_balance` | **permissionless** view | allowed | none — returns 0 while unset; like the registry's balances, the entry's TTL is renewed only on write. |
| `recipient_total_received` | **permissionless** view | allowed | none — returns 0 while unset. |
| `total_distributed` | **permissionless** view | allowed | none — returns 0 while unset. |
| `max_recipients` | **permissionless** view | allowed | none — compile-time constant; no storage access. |
| `version` | **permissionless** view | allowed | none — compile-time constant; no storage access. |
<!-- END TREASURY MATRIX -->

## Public functions that are *not* entry points

Soroban exposes only functions inside `#[contractimpl]` impls as ABI entry
points. The following `pub fn`s are deliberately **not** rows above because
they cannot be invoked as contract functions:

- `keeper-registry::internal::split_reward` — pure arithmetic, exported for
  `src/invariants.rs` and the separate fuzz crate so they test the exact
  formula the contract uses.
- `keeper-registry::reputation::effective_record` / `ReputationRecord::zero`
  — pure helpers used by the reputation views and invariants.
- `keeper-registry::events::*` / `treasury::events::*` — event emitters, called
  internally.
- `keeper-registry::invariants::assert_*` — compiled only under
  `cfg(any(test, fuzzing))`.
- `keeper-registry::mocks::*` / `treasury::mocks::*` — test-only reentrant
  token contracts, compiled only under `cfg(test)`.

The coverage test applies the same exclusion: it parses only `#[contractimpl]`
blocks in the production modules, so a new helper cannot be mistaken for a
new entry point and a new entry point cannot hide in a helper module.
