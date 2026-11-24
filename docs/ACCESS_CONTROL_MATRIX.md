# Access-control matrix

This matrix records the authorization enforced by production contract and
indexer entry points at code baseline
`22fc72304c950f539355330149dc30aef0b22a71`, plus the WebSocket controls in
the pull request containing this document. Read-only views are grouped when
they share the same policy.

Soroban `require_auth` means the named address must authorize the invocation.
`require_admin` additionally checks that the authorizing address equals the
stored administrator.

## Keeper registry

| Entry point(s) | Required authority | Additional policy |
|---|---|---|
| `initialize` | Initial `admin` address | One-time initialization. |
| `register_task`, `batch_register_tasks` | Task owner | Registry unpaused; valid reward, deadline, calldata, batch size, and token transfer. |
| `increase_reward`, `extend_deadline`, `update_verifier`, `cancel_task` | Stored task owner | Task-state and timing checks; cancel follows the documented claim-lock policy. |
| `claim_task`, `execute_task` | Keeper | Registry unpaused; claimability/lock checks; verifier gates execution where configured. |
| `withdraw_rewards` | Keeper | Allowed while paused so earned funds remain recoverable. |
| `expire_task` | Permissionless | Only succeeds after the task's eligible expiry boundary. |
| `stake_deposit`, `initiate_unbond`, `withdraw_stake` | Keeper | Amount, balance, and unbonding-window checks. |
| `raise_slash_appeal` | Slashed keeper | Existing slash, ownership, state, and appeal-window checks. |
| `dispute_execution` | Task owner | Existing executed task and configured dispute-window checks. |
| `pause`, `unpause`, `set_fee_bps`, `set_min_reward`, `set_reputation_floor`, `upgrade`, `sweep_fees` | Stored admin | Parameter bounds and operation-specific state checks. |
| `transfer_admin` | Stored admin and proposed new admin | Dual authorization prevents involuntary transfer. |
| `slash`, `set_min_stake`, `resolve_slash_appeal`, `set_dispute_window`, `resolve_execution_dispute` | Stored admin | Record/state and amount/window checks. |
| Registry, task, staking, reputation, batch, and configuration views | Permissionless | Read-only; no authorization side effect. |

## Treasury

| Entry point(s) | Required authority | Additional policy |
|---|---|---|
| `initialize` | Initial admin | One-time initialization. |
| `add_recipient`, `remove_recipient`, `update_recipient_shares`, `pause`, `unpause`, `upgrade` | Stored admin | Recipient/share bounds and operation-specific state checks. |
| `transfer_admin` | Stored admin and proposed new admin | Dual authorization. |
| `distribute` | Funding caller | Permissionless funding while unpaused; only the credited amount is transferred. |
| `withdraw` | Recipient | Allowed while paused; only the caller's accrued balance. |
| Treasury configuration and accounting views | Permissionless | Read-only. |

## Governance and governance token

| Entry point(s) | Required authority | Additional policy |
|---|---|---|
| Governance/token initialization | Configured initializer/admin | One-time initialization and address/parameter validation. |
| `create_proposal` | Proposer/creator | Proposal threshold, action encoding, and active-proposal checks. |
| `vote` | Voter | Voting window, voting power snapshot, and one-vote policy. |
| `queue_proposal`, `execute_proposal`, `evaluate_proposal` | Permissionless | Status, quorum, threshold, timelock, and replay checks determine eligibility. |
| `cancel_proposal` | Proposal creator or governance admin | Only permitted proposal states can be cancelled. |
| Governance status, tally, threshold, token-supply, and proposal views | Permissionless | Read-only. |
| Governance-token transfer/burn | Token holder or approved spender | Holder authorization or allowance consumption; total supply is fixed at initialization. |

## Conditions, verifiers, and oracle client

Condition and verifier evaluation entry points are permissionless read/evaluate
calls. They receive task/oracle inputs and return a decision; they hold no
capability to move registry funds. The oracle client is a read-only adapter to
the configured oracle interface. Mock contracts are test artifacts and are
outside the deployed access-control boundary.

## Indexer HTTP API

| Surface | Required authority | Additional policy |
|---|---|---|
| All REST reads | Permissionless; valid API key optional | Per-identity token bucket and handler-specific pagination/input bounds. Invalid/revoked presented keys return `401`. |
| WebSocket stream | Permissionless; valid API key optional | Rate-charged upgrade, verified identity, 8 sockets/client, 256/process, 5,000-event replay, validated filters, 60-second idle expiry. |
| API-key issue/list/revoke library operations | Deployment operator | No public HTTP route; deployment tooling must restrict database/process access. |

## Operational authority outside code

Repository administration, release signing, RPC credentials, database access,
deployment configuration, reverse-proxy controls, and incident response are
off-chain responsibilities. Named approvers and evidence for these controls
must be recorded in `MAINNET_READINESS.md` before deployment; this source-level
matrix does not prove that operational assignments exist.
