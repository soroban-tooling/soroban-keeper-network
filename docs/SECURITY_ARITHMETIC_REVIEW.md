# Checked arithmetic and bounded iteration review

As of 2026-11-21. Closes issue #737 and records the bounds added for #738.

## Scope and method

This review covers every `i128` amount operation and every basis point
operation in the two money-moving contracts, `contracts/keeper-registry` and
`contracts/treasury`, together with the loops and growing collections in
`keeper-registry/src/views.rs` and `keeper-registry/src/staking.rs`.

For each operation the table records whether the arithmetic is checked, what
happens on the failure path, and which way any rounding goes. "Checked" means
a Rust `checked_*` call mapped to a typed error, or a `saturating_*` call where
saturation is the intended protocol behaviour. Plain `/` and `as` casts are
listed explicitly with the reason they cannot fail.

The money invariants these operations must preserve are in
[ARCHITECTURE.md](ARCHITECTURE.md) (I-1 to I-7, with I-4 covering fee rounding)
and [TREASURY_DESIGN.md](TREASURY_DESIGN.md) section 6. The property tests in
`keeper-registry/src/invariants.rs` and `treasury/src/test/conservation.rs`
exercise those invariants directly.

## Keeper registry arithmetic

### Fee and reward split

| Operation | Location | Checked | Direction / result |
|---|---|---|---|
| `reward * fee_bps as i128` | `internal.rs:184` `split_reward` | Yes, `checked_mul` mapped to `ArithmeticOverflow` | Exact product or typed error |
| `product / 10_000` | `internal.rs:187` `split_reward` | Divisor is a non zero literal | Floor, in the keeper's favour |
| `reward - fee` | `internal.rs:190` `split_reward` | Yes, `checked_sub` mapped to `ArithmeticOverflow` | Exact complement, no value created |
| `current + amount` on `KeeperReward` | `internal.rs:208` `credit_keeper` | Yes, `checked_add` to `ArithmeticOverflow` | Exact, typed error before any write |
| `current + amount` on `FeesAccrued` | `internal.rs:277` `accrue_fee` | Yes, `checked_add` | Exact, zero amount short circuits |

`fee_bps` is validated to be at most 10,000 in `admin.rs:34` and `admin.rs:115`,
so the fee can never exceed the reward. `register_task` rejects a non positive
reward, so the multiplication is only reached with `reward > 0` and Rust's
truncating division coincides with floor. The fee is `floor(reward * bps /
10_000)` and the keeper receives the entire remainder. `keeper_net + fee ==
reward` holds exactly for every input. The shortfall against the nominal rate
is strictly less than one stroop per execution and is never collected by the
protocol.

### Stake, slash and dispute arithmetic

| Operation | Location | Checked | Direction / result |
|---|---|---|---|
| `stake + amount` on deposit | `staking.rs:44` | Yes, `checked_add` | Exact |
| `stake - amount` on withdraw | `staking.rs:94` | Yes, `checked_sub` | Exact, underflow blocked |
| `sequence + UNBOND_DELAY_LEDGERS` | `staking.rs:103` | Saturating | Never wraps the ledger counter |
| `stake + pending_unbond` | `staking.rs:201` | Yes, `checked_add` | Exact slashable exposure |
| `stake - from_stake` | `staking.rs:212`, `staking.rs:225` | Yes, `checked_sub` | Exact, cannot go negative |
| `unbond - from_unbond` | `staking.rs:236` | Yes, `checked_sub` | Exact |
| `ledger + DISPUTE_WINDOW_LEDGERS` | `staking.rs:318` | Saturating | Never wraps |
| `total + record.amount` on slash history | `staking.rs:393` | Yes, `checked_add` | Exact |
| `total + credit.net_reward` on dispute resolution | `staking.rs:540` | Yes, `checked_add` | Exact |
| `count + 1` and `total_slashed + amount` | `internal.rs:249`, `internal.rs:253` | Yes, `checked_add` | Exact |
| `sequence + window_ledgers` | `internal.rs:458` | Saturating | Never wraps |

### Pending credit arithmetic added for #738

| Operation | Location | Checked | Direction / result |
|---|---|---|---|
| `total + credit.net_reward` while finalizing | `internal.rs:495` | Yes, `checked_add` to `ArithmeticOverflow` | Exact, one credit applied to the aggregate |
| Pending list append | `internal.rs:440` | Length compared with `MAX_PENDING_CREDITS` before append | Rejects with `TooManyPendingCredits` if no slot was freed |

Matured credits are summed before a single `credit_keeper` call, so the
aggregate addition above is the only new amount operation on the finalization
path. One `RewardsFinalized` event is still emitted per credit.

### Other registry arithmetic

| Operation | Location | Checked | Direction / result |
|---|---|---|---|
| `task_id + 1`, `slash_id + 1` | `internal.rs:86`, `internal.rs:381` | `checked_add` with `expect` | Counters only, panic aborts the invocation |
| `reward + additional` on top up | `task.rs:152` | `checked_add` with `expect` | Panic aborts before any write |
| `total_reward + params.reward` in a batch | `batch.rs:75` | Yes, `checked_add` to `ArithmeticOverflow` | Exact, then compared with the caller's ceiling |
| `from + count - 1` on a range | `batch.rs:205` | Yes, `checked_add` | Exact |
| `claimed_at + lock_ledgers` | `internal.rs:342` | Saturating | Never wraps |
| `deadline - timestamp`, divided by seconds per ledger | `internal.rs:98`, `internal.rs:99` | Saturating subtraction, literal divisor | Floor, conservative TTL |
| Action counters and decay elapsed | `reputation.rs:53`, `70`, `72`, `128` | Saturating | Never wraps, score stays in range |

The three `expect` sites are the only amount additions that panic rather than
return a typed error. They are counters or a caller supplied top up where
overflow is unreachable in practice. A panic aborts the whole invocation and
Soroban discards its state changes, so no partial write can survive. Converting
them to typed errors would change the ABI for no safety gain and is out of
scope for this review.

## Treasury arithmetic

| Operation | Location | Checked | Direction / result |
|---|---|---|---|
| Sum of recipient share weights | `internal.rs:86` `total_shares` | Yes, `u32::checked_add` to `ArithmeticOverflow` | Exact, bounded by `MAX_TOTAL_SHARES` |
| `amount * shares` | `distribution.rs:59` | Yes, `checked_mul` to `ArithmeticOverflow` | Exact product or typed error |
| `product / total_shares` | `distribution.rs:61` | Denominator checked non zero | Floor per recipient, dust is not collected |
| `credited_total + share_amount` | `distribution.rs:71` | Yes, `checked_add` | Exact |
| `balance + amount` on `RecipientBalance` | `internal.rs:130` | Yes, `checked_add` | Exact |
| `received + amount` on lifetime total | `internal.rs:142` | Yes, `checked_add` | Exact |
| `current + amount` on `TotalDistributed` | `internal.rs:164` | Yes, `checked_add` | Exact |
| Share weight validation | `internal.rs:73` `validate_shares` | Range check `1..=10_000` | Rejects invalid weights before any write |

Each recipient gets `floor(amount * shares / total_shares)`. Shares are
relative weights, so the denominator is not pinned to 10,000. It is bounded by
`MAX_TOTAL_SHARES = 50 * 10_000`, which keeps the intermediate product well
inside `i128` for any valid configuration. Rounding is down for every
recipient, so the sum of credited shares is at most `amount`. The difference
is never pulled from the caller: the final token transfer moves
`credited_total`, not `amount`. Dust therefore stays with the caller rather
than being stranded in the contract. This is the same rule as the registry's
fee rounding, applied to a split instead of a fee.

## Bounded iteration and storage growth (#738)

| Loop or collection | Location | Bound | Justification |
|---|---|---|---|
| `Vec<PendingCredit>` under `DataKey::PendingReward` | `internal.rs:398`, mutated in `internal.rs:440` and `staking.rs` | `MAX_PENDING_CREDITS = 50` | New cap. At the cap, matured credits are finalized first; if none can be freed, `TooManyPendingCredits` is returned and no state changes |
| Linear lookup by task id in dispute and resolution | `staking.rs:449`, `staking.rs:519` | O(50) | Accepted. A secondary index would need invalidation on every append, finalize, dispute and resolve, which is more state than the 50 item bound warrants |
| Full vector read in `pending_credits_of` and `pending_reward` | `internal.rs:398`, `views.rs` | O(50) | Accepted, bounded by the cap |
| `get_tasks_range` | `views.rs` | `MAX_BATCH_READ = 50` | Pre existing cap on reads |
| Slash history view | `views.rs` | O(1) | Single aggregate record, not a per incident vector |
| Batch registration | `batch.rs` | `MAX_BATCH_SIZE = 50` | Pre existing cap |
| Recipient list and share reads | `treasury/distribution.rs:53`, `treasury/internal.rs:82` | `MAX_RECIPIENTS = 50`, two passes | Accepted. The denominator must be known before the split can be computed, so shares are read once for `total_shares` and once during distribution. Worst case is 100 share reads, a bounded cost |
| Unbond requests, fee accumulator, distribution totals | `staking.rs`, `internal.rs`, `treasury/internal.rs` | One scalar per keeper or per contract | No collection growth |

Before #738, `PendingReward` was the only growing collection without a bound.
Every other loop in the two contracts iterates either a fixed size scalar
record or a list that already had a cap. The cap, the typed error and the
`max_pending_credits` view were added for #738; the rest of the table is a
review of existing behaviour.

## Findings

1. **No unchecked amount arithmetic.** Every `i128` addition, subtraction and
   multiplication on a value that can move money is either `checked_*` with a
   typed error or `saturating_*` where saturation is intentional. The three
   `expect` sites are counters or caller supplied top ups that abort before
   any write, and are documented above.
2. **Rounding is consistent and favours the recipient.** The registry rounds
   the protocol fee down, so the keeper can never be charged more than the
   nominal rate. The treasury rounds each recipient's share down and never
   pulls the remainder. Both behaviours are intentional and are documented in
   the source and in [ARCHITECTURE.md](ARCHITECTURE.md). Anyone reconciling
   expected against actual revenue should expect a deficit of up to one
   stroop per operation, which is this rule and not a bug.
3. **The pending credit vector was the one unbounded structure.** It is now
   capped at 50 with finalize before append, a typed error when no slot can be
   freed, and a view that exposes the cap. Matured credits are credited in a
   single storage write while preserving one event per credit.
4. **Accepted performance bounds are documented, not changed.** O(50) linear
   lookups in the dispute paths and the treasury's two passes over at most 50
   recipients are acceptable at the current caps. A secondary index or cached
   shares would add invalidation hazards for no meaningful gain at this scale.

## Tests supporting this review

- `keeper-registry/src/test/reward_split.rs` pins conservation and the dust
  boundary for `split_reward`, including the extreme value overflow path.
- `treasury/src/test/distribution.rs` now includes a regression test with three
  equal recipients and an amount of 10: each receives 3, the caller is debited
  9, `total_distributed` is 9, and the single leftover stroop is not collected.
- `keeper-registry/src/test/conservation.rs` and
  `treasury/src/test/conservation.rs` cover the aggregate invariants.
- `keeper-registry/src/test/staking.rs` covers the new cap at the bound and one
  past it, and verifies that a full list finalizes matured credits before
  appending and still emits one event per credit.

## Verification note

Workspace wide `cargo metadata` and `cargo test` currently fail on `main`
because `contracts/governance/Cargo.toml` and
`contracts/oracle-client/Cargo.toml` contain duplicate `[lib]` keys. This is
pre existing and unrelated to this review. The registry and treasury tests
for this batch were run in a temporary copy with only those duplicate keys
patched, so no manifest change is included here. The workspace's CI job policy
is described in [CI.md](CI.md).
