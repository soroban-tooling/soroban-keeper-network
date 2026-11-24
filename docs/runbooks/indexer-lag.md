# Runbook: indexer falling behind

Use this when `IndexerIngestionLag` or `IndexerIngestFailures` fires. The steps are ordered from cheapest to most disruptive. Stop as soon as a step both explains and resolves the lag. Metric and alert names are defined in `docs/OBSERVABILITY.md`.

## 1. Confirm the alert

Read the gauge directly:

```promql
soroban_indexer_ingestion_lag_ledgers
```

Then read `/v1/health` and compare `latest_known_ledger`, `last_ingested_ledger` and `ingestion_lag_ledgers`. A lag that is falling while the alert is still open needs no action beyond noting the recovery. A flat or rising gauge means continue.

Confirmation: the gauge and the health endpoint disagree only when the scrape is stale, so check the Prometheus target page first.

## 2. Check RPC health

The indexer polls `getEvents` through `INDEXER_RPC_URL`. Call it directly:

```sh
curl -sS -X POST "$INDEXER_RPC_URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

At startup the indexer logs `checking the Soroban RPC endpoint`. A failure there stops the boot, so a running process already passed that check. In a running process, look for `ingestion failed` in the logs, which carries the RPC error context.

Rules out: an RPC endpoint that is slow or returning errors. If this fails, fix the endpoint before touching the indexer.

## 3. Check that ingestion passes are making progress

A successful pass logs `ingested events` with `stored`, `duplicates` and `last_ledger`. Confirm that `last_ledger` advances between passes. Also check the ingestion counter:

```promql
increase(soroban_indexer_events_ingested_total[10m])
```

Rules out: a quiet chain or a fully caught up indexer. Zero new events while `soroban_indexer_ingestion_lag_ledgers` is above zero is exactly the `IndexerIngestFailures` condition.

## 4. Check database pressure

For SQLite deployments, inspect the database file and look for lock errors in the logs:

```sh
ls -lh "$INDEXER_DATABASE_URL"
grep -i 'locked\|busy' indexer.log
```

The `ingested events` log line is the positive confirmation. A pass that never completes while the RPC is healthy points at the store.

Rules out: a locked or full database, or a disk that cannot accept another write.

## 5. Reduce the backfill page size

A page that is too large can hold a pass open past the poll interval. Lower `INDEXER_BACKFILL_PAGE_SIZE` from its default of 200, for example to 50, and restart. Watch for `ingested events` with a rising `last_ledger` and a falling lag gauge.

This is safe because ingestion is idempotent: a replayed page writes duplicates that are counted, not double stored.

## 6. Restart with a clean drain

Send SIGTERM and wait for `shut down cleanly`. If the log shows `drain timed out; dropping what is still running`, extend `INDEXER_SHUTDOWN_DRAIN_SECS` before the next restart. Then restart the process and recheck the lag gauge.

The checkpoint is written per pass, so a clean restart resumes from the last successful ledger rather than from genesis.

## 7. Escalate

If lag is still rising after these steps, collect the lag gauge, the last ten `ingested events` lines, the RPC health response and the database size, then escalate to the indexer maintainer. Include the values of `INDEXER_BACKFILL_PAGE_SIZE`, `INDEXER_POLL_INTERVAL_SECS` and `INDEXER_RPC_URL` with any credential redacted.
