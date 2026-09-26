# Keeper Reputation and Claim Priority

## Scope

The registry stores a keeper's successful-task rate and missed-claim count.
The score is informational: successful executions and expired lock windows
update the record, and readers can inspect both the stored record and a
read-time decayed score. This note evaluates whether that score can fairly
prioritize `claim_task` on-chain.

## Recommendation

Keep `claim_task` permissionless and first-come-first-served. Do not enforce
reputation-weighted claim priority in the registry. Reputation can help task
owners and keeper bots make decisions off-chain, but it cannot fairly reorder
simultaneous claims under the contract's current execution model.

## Why on-chain priority cannot resolve simultaneous claims

Soroban executes each transaction against the ledger's ordered transaction
set. When a claim runs, the contract can read the current task and keeper
reputation, but it cannot see claims that may be submitted later in the same
ledger or determine that two transactions were submitted “around the same
time.” The first transaction in ledger order changes the task from `Pending`
to `Claimed`; the next one sees that state and is rejected. The contract has
no control over that ordering and cannot identify which keeper asked first
outside the order consensus applied.

Adding a reputation comparison to `claim_task` therefore does not create a
priority queue. It either leaves the first successful claim as the winner, or
blocks that claimant and lets a later transaction try. Blocking a low-score
keeper still gives the high-score keeper no guarantee of winning unless the
contract waits for a defined claim window and collects competing claims
before choosing a winner.

A fair collection window would be a different protocol: keepers would need to
register claim intents, the contract would need a later selection step, and
the selection rule would need to account for duplicate identities, griefing,
timeouts, and the cost of keeping task state open. A weighted lottery would
still be probabilistic selection, rather than priority based on transaction
arrival time. None of those rules are present in the current task lifecycle,
and adding them would change the claim API and liveness guarantees.

## Off-chain use

Keeper bots may use reputation as a courtesy signal, for example by waiting a
configurable number of ledgers before attempting a task when their own score
is low. This is voluntary self-selection only: the registry cannot verify a
bot's wait, and a malicious or impatient keeper can claim immediately. It
must not be described as an enforced fairness guarantee.

Task owners and dashboards may also use reputation to decide which tasks to
advertise to which bots. That affects off-chain discovery, not the
permissionless `claim_task` rule.

## Decision

On-chain reputation is useful as an auditable, informational record. The
honest ceiling for this design is the record and its read-only views. The
registry will not reject, delay, or reorder claims based on reputation.
