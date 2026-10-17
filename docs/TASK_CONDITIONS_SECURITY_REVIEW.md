# Task Conditions Security Review

**Reviewed surface:** keeper-registry VERSION 6 condition registration,
evaluation, events, and indexer representation.

## Findings and decisions

### Owner-controlled keeper exclusion

The callback receives only `task_id`, never the prospective keeper. Its result
therefore cannot branch directly on keeper identity. An owner can still select
a condition whose state is manipulable or unavailable. This is an accepted
permissionless-owner tradeoff: attaching a condition is not registry
endorsement, and the existing cancellation and expiry paths remain available.

### Panic and malformed-contract isolation

The registry uses the generated client's fallible invocation. A false result,
missing contract, malformed response, contract error, or panic is normalized to
`ConditionNotMet`. Tests assert the task remains `Pending`, with no claimer and
no claim ledger. The callback occurs before any registry claim write.

### Front-running and information exposure

Condition state and claim transactions are public. Another keeper can observe
a condition becoming true and race for the task under the existing first-valid
claim model. The callback receives no keeper address, proof, or secret input,
so the condition API adds no private keeper-specific signal. This public race
is accepted and matches permissionless claiming.

### Reentry and state mutation

The registry makes no claim-state write before the external call. A nested
attempt to claim the same task therefore encounters the same condition and
ordinary authorization/lifecycle gates; it cannot observe a half-written
claim. A condition may change its own storage during a successful outer
invocation. Official conditions must document such behavior, and read-only
conditions are preferred, but Soroban cannot enforce purity from an address.

### Resource denial of service

The keeper submitting `claim_task` pays for the nested invocation. An expensive
condition can exhaust transaction resources and prevent a claim. The registry
fails closed and does not subsidize the call. Keepers should simulate first;
condition-specific resource ceilings and allowlists are deferred.

## Outcome

No registry-state or escrow-safety blocker was found for the implemented
interface. The review accepts availability and resource risk at the
permissionless condition boundary. It does not treat a successful callback as
proof that the condition is economically sound, immutable, audited, or safe in
future invocations.
