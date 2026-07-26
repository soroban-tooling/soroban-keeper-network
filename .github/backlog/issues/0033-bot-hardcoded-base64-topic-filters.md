---
title: "fix(keeper-bot): event topic filters are hardcoded base64 and silently match nothing if a symbol changes"
labels: [keeper-bot, bug, intermediate]
epic: E15
wave: 1
depends_on: []
---

## Summary

The event filter contains pre-encoded base64 XDR strings with a comment explaining what they are supposed to mean. If the contract's event symbols ever change, the filter matches nothing, the bot reports zero tasks, and nothing indicates an error.

## Current behaviour

```js
const response = await server.getEvents({
  startLedger,
  filters: [
    {
      type: "contract",
      contractIds: [contractId],
      topics: [
        ["AAAADwAAAANyZWc=", "AAAADwAAAAR0YXNr"], // "reg", "task" as base64 XDR
      ],
    },
  ],
  limit: 100,
});
```

## Why this is dangerous rather than merely ugly

The failure is silent and looks like success. `getEvents` with a non-matching filter returns an empty list, not an error. The bot then logs:

```
📋  Found 0 TaskRegistered events to evaluate
```

which is exactly what it logs during a genuinely quiet period. An operator has no way to distinguish "no tasks right now" from "this bot has been broken since the last contract deploy". Every downstream behaviour — claiming, executing, earning — silently stops.

The hazard is real, not theoretical. The README's own events table already disagrees with the contract's emitted symbols in at least one place, which is proof that these strings drift. Anyone renaming an event symbol will grep for the symbol name, find nothing in the bot, and reasonably conclude the bot does not consume it.

There is a second problem: the encoding is unverifiable by inspection. A reviewer cannot confirm `"AAAADwAAAANyZWc="` decodes to `"reg"` without running a decoder, so the comment is the only documentation and there is nothing to check it against.

## Expected behaviour

Topic filters are constructed from the symbol names at runtime, so the source reads as `"reg"` and `"task"`, and a mismatch is impossible to introduce by editing a string.

## Suggested approach

Build the ScVal and encode it, rather than pasting the result:

```js
const { xdr, nativeToScVal } = require("@stellar/stellar-sdk");

/**
 * Encodes a Soroban symbol as the base64 XDR string `getEvents` expects for a
 * topic filter. Derived at runtime so the filter always matches the symbol
 * written here, and a contract-side rename surfaces as a code change rather
 * than a filter that silently stops matching.
 */
function topicSymbol(name) {
  return nativeToScVal(name, { type: "symbol" }).toXDR("base64");
}

const REGISTRY_EVENTS = {
  taskRegistered: [topicSymbol("reg"), topicSymbol("task")],
  taskClaimed:    [topicSymbol("claim"), topicSymbol("task")],
  taskExecuted:   [topicSymbol("exec"), topicSymbol("task")],
};
```

`xdr` is already imported and currently unused, which is tracked separately.

Two further improvements worth including:

**Assert the symbols fit.** `symbol_short!` in the contract caps topics at 9 characters. A JS-side check that each name is 9 characters or fewer catches a class of mistake at startup rather than at runtime.

**Make the silence loud.** Log distinctly when a query returns zero events across many consecutive rounds. A warning after, say, 30 empty rounds turns a silent breakage into something an operator notices.

That second point matters more than the encoding fix. Deriving the filter correctly removes today's instance of the bug; a warning catches the next one, whatever causes it.

## Acceptance criteria

- [ ] No hardcoded base64 XDR strings remain in the bot.
- [ ] Topic filters are derived from symbol names at runtime.
- [ ] Symbol names are defined once in a named map and referenced everywhere.
- [ ] Names longer than the 9-character `symbol_short!` limit fail loudly at startup.
- [ ] Sustained empty results produce a warning distinguishable from a quiet network.
- [ ] A comment cross-references the contract's emitter functions so the two stay linked.

## Files

- `examples/keeper-bot/index.js`
