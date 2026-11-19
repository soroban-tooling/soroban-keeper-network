# Mainnet readiness checklist

Mainnet deployment is **NO-GO** until every required item is checked and its evidence link resolves to an immutable report, transaction, configuration snapshot, or rehearsal record. A repository document describing a control is not evidence that the control is operating.

## Contract assurance

- [ ] Independent contract audit is complete, all critical/high findings are closed, and accepted residual risks are signed off. Evidence: final report linked from [`AUDIT_SCOPE.md`](./AUDIT_SCOPE.md).
- [ ] Release WASM hash matches the audited commit and reproducible-build output. Evidence: release artifact and CI digest from [`DEPLOYING.md`](./DEPLOYING.md#reproducing-a-release-hash-locally).
- [ ] Upgrade and rollback were exercised on testnet. Evidence: dated transaction links and operator record.
- [ ] Fuzz, unit, integration, and SDK compatibility suites pass on the release commit. Evidence: immutable CI run and commands from [`CI.md`](./CI.md).

## Administrative control

- [ ] Registry and treasury admin are controlled by the approved multisig, not an individual key. Evidence: account address, signer/threshold query, and initialization transaction.
- [ ] Admin signers use approved hardware or managed custody and tested recovery. Evidence: redacted ceremony record.
- [ ] Pause, unpause, upgrade, fee change, and treasury sweep responsibilities have named approvers. Evidence: approved access-control matrix.

## Operations and monitoring

- [ ] At least two independently operated keepers are live and funded with bounded fee ceilings. Evidence: public addresses, health dashboard, and testnet execution history.
- [ ] Indexer lag, RPC failure, missed execution, low balance, pause, and unexpected admin-event alerts reach on-call. Evidence: dated alert-test results.
- [ ] Metrics endpoints are private or authenticated and expose no secrets or raw calldata. Evidence: deployment configuration and [`KEEPER_BOT_V2_SECURITY_REVIEW.md`](./KEEPER_BOT_V2_SECURITY_REVIEW.md).
- [ ] Backup and restore of indexer/operator state was tested. Evidence: dated restore report with recovery objectives.

## Runbooks and incident response

- [ ] Deployment, rollback, key rotation, RPC failover, keeper drain, pause, and recovery runbooks are reviewed. Evidence: approved revision links.
- [ ] Incident severity, communication, evidence preservation, and disclosure ownership are assigned. Evidence: incident plan and contact rota.
- [ ] A testnet exercise covering compromised keeper key and stalled indexer was completed. Evidence: dated timeline, findings, and closed follow-ups.
- [ ] The contact and disclosure policy in [`SECURITY.md`](../SECURITY.md) are monitored. Evidence: verified inbound test and response record.

## Launch decision

- [ ] Release owner records GO with every item above, release commit, deployed contract IDs, network configuration, and UTC launch time.
- [ ] A second authorized reviewer independently verifies the evidence and signs the decision.
