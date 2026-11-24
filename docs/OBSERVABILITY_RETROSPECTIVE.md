# Epic E18 retrospective: observability

As of 2026-11-21. Closes issue #732.

Epic E18 set out to give the Keeper Network one observability story: a plan in
`docs/OBSERVABILITY.md`, metrics and structured logs in the indexer and bots,
alerting and dashboards for operators, runbooks for the common incidents, and
a security review of what the new telemetry exposes.

This retrospective records what was delivered against that plan, what is still
sitting in an open pull request, and what was deferred. It is written from the
issue tracker and the pull requests that reference the E18 issues, not from a
deployed system. No E18 issue is closed and no E18 delivery pull request is
merged as of the as-of date, and `docs/OBSERVABILITY.md` is not on `main`.

## Status vocabulary

- **Merged on `main`**: the change is in the default branch. No E18 item has
  this status at the as-of date.
- **In an open pull request**: the work is implemented and the pull request
  names the issue in a `Closes` line, but it is not merged.
- **Not implemented**: no pull request references the issue.

## Status of every E18 issue (#713 to #732)

| Issue | Work | Status | Delivery |
|---|---|---|---|
| #713 | Observability plan across contract, indexer and bots | In an open pull request | [#941](https://github.com/soroban-tooling/soroban-keeper-network/pull/941) |
| #714 | Indexer `Prometheus /metrics` endpoint | In an open pull request | [#939](https://github.com/soroban-tooling/soroban-keeper-network/pull/939) |
| #715 | Indexer optional JSON log output | In an open pull request | [#939](https://github.com/soroban-tooling/soroban-keeper-network/pull/939) |
| #716 | Indexer tracing spans for ingest passes and API requests | In an open pull request | [#937](https://github.com/soroban-tooling/soroban-keeper-network/pull/937) |
| #717 | Optional Prometheus metrics for the v1 keeper bot | In an open pull request | [#937](https://github.com/soroban-tooling/soroban-keeper-network/pull/937) |
| #718 | Keeper bot v2 liveness and readiness endpoints | In an open pull request | [#941](https://github.com/soroban-tooling/soroban-keeper-network/pull/941) |
| #719 | Prometheus alert rules for the indexer and keeper bots | In an open pull request | [#942](https://github.com/soroban-tooling/soroban-keeper-network/pull/942) |
| #720 | Grafana dashboards for the indexer and keeper bot v2 | In an open pull request | [#942](https://github.com/soroban-tooling/soroban-keeper-network/pull/942) |
| #721 | Docker Compose observability stack | Not implemented | No pull request |
| #722 | Runbook: indexer falling behind | Not implemented | No pull request |
| #723 | Runbook: Soroban RPC outage | In an open pull request | [#941](https://github.com/soroban-tooling/soroban-keeper-network/pull/941) |
| #724 | Runbook: keeper account running out of XLM | In an open pull request | [#939](https://github.com/soroban-tooling/soroban-keeper-network/pull/939) |
| #725 | Runbook: protocol paused | In an open pull request | [#939](https://github.com/soroban-tooling/soroban-keeper-network/pull/939) |
| #726 | Contract state monitor for admins | In an open pull request | [#942](https://github.com/soroban-tooling/soroban-keeper-network/pull/942) |
| #727 | Testnet canary task proving end to end liveness | In an open pull request | [#942](https://github.com/soroban-tooling/soroban-keeper-network/pull/942) |
| #728 | Service level objectives for the indexer API and keeper network | Not implemented | No pull request |
| #729 | Optional OpenTelemetry trace export | Not implemented | No pull request |
| #730 | Metric name check against the documented scheme | In an open pull request | [#936](https://github.com/soroban-tooling/soroban-keeper-network/pull/936) |
| #731 | Security review of metrics and logs for sensitive data | In an open pull request | [#936](https://github.com/soroban-tooling/soroban-keeper-network/pull/936) |
| #732 | Epic E18 retrospective | This document | This pull request |

All five delivery pull requests are open, so the statuses above can change
without a change to the issues themselves. The delivery column is a snapshot,
not a commitment that a given issue will close with its current pull request.

## Divergences from the plan

1. **Retrospective file name.** The acceptance criteria for #732 name
   `docs/OBSERVABILITY.md`. This retrospective is deliberately in
   `docs/OBSERVABILITY_RETROSPECTIVE.md` instead. Pull requests #936 and #941
   both add `docs/OBSERVABILITY.md` for #713 and #731. Writing the retrospective
   to that path here would create a file collision and would let whichever
   pull request merges second overwrite the other's work. The plan document is
   still delivered by those pull requests, and this retrospective is the record
   of how the epic went. The two documents serve different purposes and are
   meant to coexist.
2. **Plan of record.** Because `docs/OBSERVABILITY.md` is not on `main`, the
   epic issue set #713 to #732 is used as the plan of record and the five
   delivery pull requests as the delivery record. Where an issue body was more
   specific than the epic summary, the issue body was used.
3. **Sequencing.** #732 says to start after #731 and #728 are closed. At the
   as-of date #731 is implemented in the open pull request #936 and #728 has no
   pull request at all. Waiting for both to close would leave the retrospective
   unwritten indefinitely, so it records the as-is state and does not assert
   that service level objectives have been defined.
4. **Epics boundary.** The adjacent issues #710 to #712 belong to the CLI epic
   E16, and #733 to #735 belong to the security epic. They are not counted as
   E18 work here even though #733 and #734 ship in the same pull request as the
   E18 items #730 and #731. Those security items are tracked in
   [AUDIT_SCOPE.md](AUDIT_SCOPE.md) instead.

## Deferrals

Four E18 issues have no pull request and are deferred, not forgotten:

- **#721, Docker Compose observability stack.** Operators must still assemble
  the Prometheus and Grafana components themselves. Deferred because the
  individual exporters and dashboards (#714, #715, #719, #720) are only now
  landing, and packaging them before they stabilise would freeze a moving
  layout.
- **#722, runbook for an indexer falling behind.** The other three runbooks
  (#723, #724, #725) are in open pull requests. This one is deferred until the
  lag metrics and alert rules (#714, #719) settle, so the runbook can reference
  final metric and alert names.
- **#728, service level objectives for the indexer API and keeper network.**
  Deferred. This is the most consequential deferral: without agreed objectives
  the alert rules in #719 have no error budget to defend, and #732 could not
  be sequenced strictly as written. It remains a prerequisite for treating
  the alerting layer as complete.
- **#729, optional OpenTelemetry trace export.** Deferred. In process tracing
  is delivered by #716, but there is no external trace export yet.

## Partial coverage worth naming

- Tracing spans (#716) ship, but the OpenTelemetry export (#729) does not.
  Telemetry is therefore inspectable locally but not yet exportable to a trace
  backend.
- The sensitive data review (#731) and the metric name check (#730) land in
  pull request #936 together with the system threat model (#733) and the
  consolidated invariants reference (#734). Reviewing the new telemetry in
  isolation from those two documents is not sufficient.
- The liveness endpoints (#718), runbook (#723), and observability plan (#713)
  are all in pull request #941, but the canary task (#727) that would prove end
  to end liveness is in a separate pull request, #942. Until both merge, the
  probes exist without the synthetic task that exercises them.

## Related security follow-ups outside E18

The operational reviews identified follow ups that are tracked on their own,
not as E18 work:

- Indexer findings IDX-SEC-01, IDX-SEC-02 and IDX-SEC-03 in
  [INDEXER_SECURITY_REVIEW.md](INDEXER_SECURITY_REVIEW.md). The indexer API is
  not approved for general availability until they are closed or explicitly
  replaced.
- Metrics and admin endpoint exposure in
  [KEEPER_BOT_V2_SECURITY_REVIEW.md](KEEPER_BOT_V2_SECURITY_REVIEW.md), resolved
  by design through local binding and secret safe metric labels.

## Maintaining this document

Update the status table when any of the five delivery pull requests merges or
closes, and record the merge commit in the status vocabulary section. Add a new
row if a deferred issue gains a pull request. Keep the as-of date at the top
current, and do not merge this retrospective into `docs/OBSERVABILITY.md`.
