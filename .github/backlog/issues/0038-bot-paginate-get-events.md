---
title: "feat(keeper-bot): paginate getEvents instead of silently truncating at 100"
labels: [keeper-bot, bug, intermediate]
epic: E15
wave: 1
depends_on: []
---

## Summary

The event query passes `limit: 100` and ignores the pagination cursor in the response. When more than 100 registration events fall inside the scan window, the remainder are dropped with no indication.

## Current behaviour

```js
const response = await server.getEvents({
  startLedger,
  filters: [ /* ... */ ],
  limit: 100,
});

for (const event of response.events || []) {
  // ...
}
```

`response.cursor` is never read and no further page is requested.

## Why it matters

The scan window is roughly 1000 ledgers, about 1.4 hours. Exceeding 100 registrations in that period is not an extreme scenario — it is a modestly successful network, or a single protocol registering tasks on a schedule.

The truncation is silent and its effects are systematic rather than random:

- The bot sees only the first page, which is the *oldest* events in the window.
- Those are the ones most likely to be already claimed or executed by competitors.
- New tasks — the profitable ones — are past the cut and never seen.

So the bot degrades in precisely the wrong direction as the network gets busier: it works hardest on stale tasks and never reaches fresh ones. Combined with the fixed-window re-scanning issue, a busy period can leave it permanently stuck on a page of tasks it can never win.

There is no error and no warning. `response.events.length === 100` is the only hint, and nothing checks it.

## Expected behaviour

The bot follows the cursor until the window is exhausted or a documented page budget is reached, and logs clearly when it stops early.

## Suggested approach

```js
/**
 * Fetches TaskRegistered events across the window, following the pagination
 * cursor. Bounded by maxPages so one very busy window cannot stall a round
 * indefinitely; hitting the bound is logged, never silent.
 */
async function fetchPendingTasks(server, contractId, startLedger, maxPages = 10) {
  const tasks = [];
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    const request = cursor
      ? { filters, cursor, limit: PAGE_SIZE }
      : { filters, startLedger, limit: PAGE_SIZE };

    const response = await server.getEvents(request);
    // ... decode into tasks ...

    pages++;
    if (!response.events || response.events.length < PAGE_SIZE || !response.cursor) {
      break; // window exhausted
    }
    cursor = response.cursor;
  }

  if (pages === maxPages) {
    console.warn(`⚠️  Stopped after ${maxPages} pages — more events remain in this window.`);
  }
  return tasks;
}
```

Note the API constraint: `startLedger` and `cursor` are mutually exclusive in the Soroban RPC `getEvents` call. Pass `startLedger` on the first request only and `cursor` on subsequent ones. Verify this against the RPC version the bot targets — the interaction has changed across releases, and getting it wrong produces an error rather than silent truncation, which is at least easy to notice.

Bound the page count. Unbounded pagination turns a busy window into a round that never finishes, which is a worse failure than truncation. Ten pages at 100 events is 1000 tasks per round, far more than `MAX_TASKS_PER_ROUND` can act on anyway — so the real fix for sustained volume is the cursor work in the re-scanning issue, and this change is about not losing data silently.

## Acceptance criteria

- [ ] `fetchPendingTasks` follows the pagination cursor.
- [ ] Page size and maximum page count are named constants, configurable via environment.
- [ ] Reaching the page limit logs a warning naming the limit.
- [ ] `startLedger` and `cursor` are not sent in the same request.
- [ ] Total events fetched per round is logged.
- [ ] The RPC version the pagination behaviour was verified against is noted in a comment.

## Files

- `examples/keeper-bot/index.js`
- `examples/keeper-bot/.env.example`

## References

- [Soroban RPC getEvents](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getEvents)
