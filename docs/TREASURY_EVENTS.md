# Treasury Events

Events are the treasury contract's audit trail. The table below is
transcribed from the `emit_*` functions in
`contracts/treasury/src/events.rs` and lists every event the contract emits,
and nothing it does not. It follows the format of the registry's table in
[README.md's Events section](../README.md#events). Build event filters from
the **Topics** column only. The `Event` names are documentation labels, not
on-chain values.

Every event publishes exactly two topic symbols. Both are `symbol_short!`
literals, which Soroban limits to **9 characters**, so several topics are
abbreviated (`radd`, `rrm`, `rshr`, `wdraw`). The abbreviations are part of
the on-chain interface and cannot be "corrected" without breaking existing
consumers.

| Event | Emitted by | Topics | Data (in order, with type) |
|-------|-----------|--------|----------------------------|
| `Initialized` | `initialize` | `("init", "admin")` | `(admin: Address, reward_token: Address)` — emitted at most once |
| `RecipientAdded` | `add_recipient` | `("radd", "recip")` | `(recipient: Address, shares_bps: u32)` |
| `RecipientRemoved` | `remove_recipient` | `("rrm", "recip")` | `(recipient: Address,)` — the recipient's share becomes 0 |
| `RecipientSharesUpdated` | `update_recipient_shares` | `("rshr", "recip")` | `(recipient: Address, old_shares_bps: u32, new_shares_bps: u32)` |
| `Distributed` | `distribute` | `("dist", "recip")` | `(recipient: Address, amount: i128, total_distributed: i128)` — one per credited recipient; `total_distributed` is the lifetime total after this credit |
| `Distribution` | `distribute` | `("dist", "total")` | `(caller: Address, requested: i128, credited: i128, breakdown: Vec<(Address, i128)>)` — exactly one per successful call, after its `Distributed` events |
| `Withdrawn` | `withdraw` | `("wdraw", "recip")` | `(recipient: Address, amount: i128)` |
| `Paused` | `pause` / `unpause` | `("paused", "admin")` | `(paused: bool,)` — `true` from `pause`, `false` from `unpause` |
| `AdminTransferred` | `transfer_admin` | `("admin", "xfer")` | `(old_admin: Address, new_admin: Address)` |
| `Upgraded` | `upgrade` | `("upgrade", "admin")` | `(admin: Address, new_wasm_hash: BytesN<32>)` — emitted before the executable is swapped |

Notes:

- A rejected call emits nothing: every entry point returns before its event
  on any error, and a failed invocation's storage writes are rolled back.
- `("dist", "recip")` and `("dist", "total")` share a first topic. Filter on
  both topics to tell them apart.
- `requested` in `Distribution` is the amount the caller asked to distribute.
  `credited` is what was actually credited and pulled from the caller.
  Pro-rata shares are floor-rounded per recipient, and the remainder
  (`requested - credited`) is never collected, so it stays with the caller.
- `breakdown` lists every registered recipient in registration order with the
  amount credited to it, **including zero** for a recipient whose rounded
  share was zero. Its amounts sum to `credited`. Only nonzero amounts also get
  a `Distributed` event.

## Reconstructing the recipient configuration

The configuration at any point in history can be rebuilt from events alone
by replaying them in ledger order onto an empty list:

1. `RecipientAdded`: append `{ recipient, shares_bps }` to the end of the list.
2. `RecipientSharesUpdated`: set that recipient's share to `new_shares_bps`.
   `old_shares_bps` must equal the share the replay already holds, which lets
   a consumer detect a missed event.
3. `RecipientRemoved`: delete that recipient from the list. The remaining
   recipients keep their relative order.

The result matches the `recipients()` view, order included. A removed
recipient can be re-added later. It then appears as a new `RecipientAdded` at
the end of the list. `contracts/treasury/src/test/events.rs`
(`test_configuration_history_is_reconstructable_from_events`) checks this
replay against the live view after every step.

Configuration changes affect only future distributions. Balances already
credited are never recomputed or moved, and a removed recipient can still
`withdraw` what it earned. See the "Mid-flight configuration changes" note in
`contracts/treasury/src/admin.rs`.
