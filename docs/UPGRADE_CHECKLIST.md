# Contract Upgrade Safety Checklist

This checklist is a required sequence for safely upgrading the `KeeperRegistry` contract (or any contract in the Soroban Keeper Network) from one VERSION to the next. Each step has a verification criterion; the upgrade proceeds only once all checks pass.

Because Soroban upgrades replace the WASM in place without state migration, storage compatibility must be verified before any deployment. This document is the responsibility of whoever initiates the upgrade (typically an admin or governance action).

---

## 1. Storage Schema Compatibility

**Goal:** Ensure the new WASM can deserialize all existing on-chain state without data loss or corruption.

### 1.1 Verify no breaking changes to `#[contracttype]` structs

- [ ] Read the new contract code and identify all `#[contracttype]` structs (e.g., `Task`, `UnbondRequest`, `SlashRecord`, `PendingCredit`, `ReputationRecord`).
- [ ] Compare each struct's fields, order, and types against the currently deployed version.
- [ ] Check the [STORAGE_LAYOUT.md](STORAGE_LAYOUT.md) and version history for known incompatibilities.

**Incompatible changes:**
- Removing a field from a struct
- Changing a field's type (e.g., `u32` → `u64`, or `i128` → `u128`)
- Reordering fields within a struct
- Changing from `Option<T>` to `T` (or vice versa) on a field that is already in use on-chain

**Compatible changes:**
- Adding a new field with a default value at the end of a struct (e.g., `new_field: Option<Address>`), provided the new field is `Option<T>` or has a sensible default if later code reads it
- Removing a field that is known to be uninitialized on all live deployments (audited via logs and event scans)

### 1.2 Check `DataKey` enum for changes

- [ ] Verify the `DataKey` enum (storage key discriminator) has not been altered in a way that changes how existing entries are read.
- [ ] If new variants were added, confirm they do not collide with existing key hashes.
- [ ] If variants were removed or reordered, ensure no live deployment uses them.

**Reference:** Soroban's XDR encoding relies on enum discriminant order. Reordering or removing variants mid-sequence breaks deserialization of old entries.

### 1.3 Run the storage compatibility test suite

- [ ] Locate the test in `contracts/keeper-registry/src/test/condition.rs` named `pre_condition_task_encoding_requires_explicit_migration` (or similar versioned compatibility tests).
- [ ] If no compatibility test exists for this version bump, create one:
  - Serialize a `Task` (or other key struct) in the old format.
  - Verify the new contract rejects it (if the schema changed) or deserializes it correctly.
  - Document the test and commit it to the repository.

**Command to run existing tests:**
```bash
cargo test -p keeper-registry --test '*' -- --nocapture
```

- [ ] All compatibility tests pass.

### 1.4 Audit event deserialization

- [ ] Review all `emit_*` functions in `contracts/keeper-registry/src/events.rs`.
- [ ] Confirm that event topics and field types have not changed in a way that breaks off-chain indexers.
- [ ] If events were added, updated, or removed, notify the indexer operator (see [Indexer Notification](#6-announcement-and-coordination)).

**Why:** Indexers and keeper bots parse emitted events off-chain. A breaking change to event shape requires indexer updates to avoid gaps or misinterpretations in the historical record.

---

## 2. Version Bump

**Goal:** Signal to off-chain clients and indexers that the contract behavior has changed.

### 2.1 Update `VERSION` constant

- [ ] Open `contracts/keeper-registry/src/constants.rs`.
- [ ] Increment `const VERSION: u32` by 1.
- [ ] Add a comment documenting what changed in this version (e.g., "Added task conditions", "Staking and slashing", etc.).

**Reference:** Current VERSION is defined in `constants.rs`. See the comments there for the historical version log.

### 2.2 Rebuild and verify version

- [ ] Run `make wasm` (or `./scripts/optimize.sh`) to produce the optimized WASM.
- [ ] Query the new WASM to confirm the version is correct:
  ```bash
  stellar contract invoke --wasm target/wasm32-unknown-unknown/release/keeper_registry.wasm version
  ```
- [ ] Confirm the output matches the bumped `VERSION` constant.

### 2.3 Commit version change

- [ ] Stage and commit the version bump:
  ```bash
  git add contracts/keeper-registry/src/constants.rs
  git commit -m "v$(VERSION): <description>"
  ```

---

## 3. Testnet Rehearsal

**Goal:** Execute a dry run of the upgrade on testnet before any mainnet deployment. This catches runtime errors, indexer incompatibilities, and keeper-bot failures in a low-risk environment.

### 3.1 Prepare testnet environment

- [ ] Ensure you have a testnet identity with sufficient XLM for deployment:
  ```bash
  stellar keys generate upgrade-admin --network testnet
  stellar keys fund upgrade-admin --network testnet  # if needed
  ```
- [ ] If a testnet registry already exists, document its contract ID and current VERSION.

### 3.2 Deploy to testnet

- [ ] Use the upgrade admin's identity to invoke the `upgrade` entry point on the existing testnet registry:
  ```bash
  stellar contract invoke \
    --network testnet \
    --id <testnet-registry-contract-id> \
    --source upgrade-admin \
    -- \
    upgrade \
    --admin <upgrade-admin-address> \
    --new_wasm_hash <new-wasm-hash>
  ```
- [ ] Replace `<testnet-registry-contract-id>` with the current deployed contract ID from [DEPLOYMENTS.md](DEPLOYMENTS.md).
- [ ] Replace `<new-wasm-hash>` with the hash of the optimized WASM (printed by `make wasm`).

### 3.3 Verify post-upgrade state

- [ ] Query the contract to confirm it is running the new VERSION:
  ```bash
  stellar contract invoke \
    --network testnet \
    --id <testnet-registry-contract-id> \
    --source <any-account> \
    -- \
    version
  ```
- [ ] Confirm the response is the new VERSION number.

- [ ] Query existing task data to ensure nothing was corrupted:
  ```bash
  stellar contract invoke \
    --network testnet \
    --id <testnet-registry-contract-id> \
    --source <any-account> \
    -- \
    task_count
  ```
- [ ] Confirm `task_count` is non-zero (if tasks existed before) and unchanged.

- [ ] Retrieve a sample task by ID and verify all fields are present and correct:
  ```bash
  stellar contract invoke \
    --network testnet \
    --id <testnet-registry-contract-id> \
    --source <any-account> \
    -- \
    get_task \
    --task_id <sample-task-id>
  ```
- [ ] Spot-check: `owner`, `reward`, `status`, `deadline` should match historical records or logs.

### 3.4 Smoke test: new functionality

- [ ] If the upgrade introduces new functions or behavior, test them on testnet:
  - Register a new task and verify it uses the new schema.
  - Claim and execute the task to confirm the new logic flows correctly.
  - Query balances and verify keeper rewards are calculated with any new logic.

- [ ] Document the test results (transaction IDs, timestamps, expected vs. observed behavior).

### 3.5 Run the indexer on upgraded testnet

- [ ] If an indexer operates on testnet, restart or update it to consume events from the upgraded contract:
  - [ ] Indexer starts successfully without errors.
  - [ ] Indexer processes existing events without gaps or misinterpretations.
  - [ ] Indexer correctly handles new event types or updated fields (if any).
  - [ ] Query the indexer's database to confirm task records match the contract state.

**See:** [INDEXER_DEPLOYMENT.md](INDEXER_DEPLOYMENT.md) for indexer procedures.

### 3.6 Notify keeper bots to redeploy

- [ ] Send an announcement to keeper-bot operators (see [Announcement & Coordination](#6-announcement-and-coordination)):
  - Upgraded contract ID and new VERSION
  - Any breaking changes to task structure or execution proofs
  - URL to this upgrade checklist and the VERSION comments

- [ ] Wait for at least one bot operator to confirm successful connection and task execution on testnet.

### 3.7 Monitor for 24–48 hours

- [ ] Let the upgraded testnet contract run under live bot traffic for at least one full day.
- [ ] Watch for:
  - Transaction failures or gas/resource exhaustion errors
  - Keeper bot disconnection or malformed claim/execute attempts
  - Indexer backlog or dropped events
  - Anomalies in keeper reward distribution or balance calculation

- [ ] If issues surface, fix them and repeat from step 3.2 (or revert to the previous version if the issue is critical and unfixable in the remaining release window).

- [ ] Document observations in an upgrade report (template below).

---

## 4. Announcement & Coordination

**Goal:** Notify all affected parties and coordinate the upgrade with a maintenance window if necessary.

### 4.1 Prepare upgrade announcement

- [ ] Draft an announcement that includes:
  - **Affected contracts:** "KeeperRegistry" (and any others in this release)
  - **Timeline:** deployment date, expected duration, rollback plan
  - **What changed:** high-level summary of new features and fixes (link to CHANGELOG.md)
  - **Storage compatibility:** "State migration required?" and details of any migration steps
  - **Keeper-bot action required:** "No" (for additive changes) or "Yes" (for breaking changes)
  - **Indexer action required:** "No" or "Yes" + link to updated schema
  - **Point of contact:** admin address and Discord/Slack for questions during the upgrade

**Example:**
```markdown
## KeeperRegistry Upgrade Notice

**Deployment Date:** 2025-01-30 14:00 UTC
**Duration:** ~5 minutes
**New VERSION:** 7

### What's Changing
- Added task conditions (optional on-chain checks before claim)
- Storage schema is backward compatible
- Keeper bots: no action required
- Indexers: must update event parsers for new `TaskConditionNotMet` event

### Rollback Plan
If critical issues emerge within 1 hour, admin will revert to VERSION 6 using the upgrade function.

### Questions?
Reach out in #keeper-network or reply to this thread.
```

### 4.2 Publish and distribute announcement

- [ ] Post the announcement to:
  - Discord #keeper-network channel (or equivalent)
  - GitHub Discussions or Releases page
  - Email to registered indexer operators and keeper-bot maintainers
  - Community documentation site (if any)

- [ ] Allow at least 24 hours for teams to prepare (or more if breaking changes are present).

### 4.3 Schedule maintenance window (if needed)

- [ ] If the upgrade requires a brief pause (e.g., indexer rebuild), schedule a window and announce it.
- [ ] Confirm all stakeholders have acknowledged the announcement.

---

## 5. Rollback Plan

**Goal:** Have a documented, tested procedure to revert the upgrade if critical issues emerge post-deployment.

### 5.1 Preserve previous WASM

- [ ] Before deploying the new WASM, save the previous version:
  ```bash
  # Fetch the current WASM from the contract on mainnet (or your target network)
  soroban contract inspect <contract-id> --network <network>
  # Document the hash and save the WASM file locally
  ```

- [ ] Store the previous WASM hash and a link to the previous contract binary in this document or a wiki entry.

### 5.2 Document rollback procedure

- [ ] Rollback is triggered by the same `upgrade` entry point, using the previous WASM hash:
  ```bash
  stellar contract invoke \
    --network mainnet \
    --id <contract-id> \
    --source <admin-identity> \
    -- \
    upgrade \
    --admin <admin-address> \
    --new_wasm_hash <previous-wasm-hash>
  ```

- [ ] Rollback is instant (atomic on-chain); all state is preserved (no data loss, unlike a redeploy).

### 5.3 Rollback decision criteria

- [ ] Rollback is triggered if, within the first hour of deployment, one or more of the following occurs:
  - Contract entry point calls consistently fail with an unexpected error
  - Keeper bots report inability to parse contract responses
  - Indexer backlog grows indefinitely or events are dropped
  - Task execution fails for all tasks (indicating a logic error)
  - Keeper rewards are not being credited correctly

- [ ] Rollback is NOT triggered for:
  - Minor indexer delays (indexers can catch up)
  - Isolated bot failures (bot may have a local bug unrelated to the contract)
  - New features working as designed but with different gas costs

### 5.4 Post-rollback analysis

- [ ] After rollback, conduct a root cause analysis:
  - Run the full test suite to identify the failure mode
  - Compare the failing WASM against the passing one using binary diff tools
  - Re-read the storage compatibility test
- [ ] Once the issue is resolved, prepare a patched WASM and repeat from step 3.2 (testnet).

---

## 6. Rollback Notification

**Goal:** Inform all stakeholders immediately if rollback occurs.

### 6.1 Post rollback announcement

- [ ] Announce the rollback with the same urgency as the original deployment:
  - "Rolled back to VERSION [X] due to [reason]"
  - "Investigation underway; next steps will be communicated within 4 hours"
  - Expected timeline for the next deployment attempt

- [ ] Distribute the announcement to the same channels as the upgrade notice (Discord, email, etc.).

### 6.2 Enable monitoring and fixes

- [ ] Re-enable keeper bots to use the previous VERSION (no configuration change needed; they auto-detect via contract query).
- [ ] Monitor the previous version for any lingering issues (give it 1–2 hours).

---

## 7. Post-Deployment Verification (Mainnet)

**Goal:** Confirm the upgrade completed successfully on the live network and all downstream systems are operational.

### 7.1 Verify contract is running new WASM

- [ ] Query the contract version:
  ```bash
  stellar contract invoke \
    --network mainnet \
    --id <mainnet-registry-contract-id> \
    --source <any-account> \
    -- \
    version
  ```
- [ ] Confirm the response is the new VERSION number.

### 7.2 Verify state integrity

- [ ] Query `task_count` and compare it to pre-upgrade count (should be unchanged).
- [ ] Retrieve a sample of existing tasks (at least 5) and verify fields are intact.
- [ ] Check a few keeper balances to confirm they are unchanged.

### 7.3 Verify live keeper-bot traffic

- [ ] Monitor the contract's events for 30 minutes:
  - [ ] `TaskClaimed` events appear (keepers are still claiming)
  - [ ] `TaskExecuted` events appear (keepers are still executing)
  - [ ] No spike in `VerificationFailed` or error events
- [ ] Spot-check keeper logs (if accessible) for any new errors.

### 7.4 Verify indexer health

- [ ] Indexer continues to sync events without gaps.
- [ ] Indexer correctly processes any new event types.
- [ ] Query the indexer's view of a recent task and confirm it matches the contract's current state.

### 7.5 Update deployment record

- [ ] Update [DEPLOYMENTS.md](DEPLOYMENTS.md) with:
  - New contract ID (if it changed, e.g., full redeploy)
  - New WASM hash
  - Date and time of deployment
  - Link to this checklist instance (or upgrade report)

**Example:**
```markdown
## Mainnet (Updated 2025-01-30)

| Field | Value |
|-------|-------|
| Contract ID | `CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4` |
| VERSION | 7 |
| WASM hash | `a1b2c3d4e5f6...` (new) |
| Upgraded from | VERSION 6 on 2025-01-30 14:15 UTC |
| Rollback plan | Revert to hash `e9defafc84fd...` if critical issue emerges |
```

### 7.6 Declare upgrade complete

- [ ] Post a final announcement:
  - "KeeperRegistry upgraded to VERSION 7 successfully"
  - "No issues detected; all systems operational"
  - "Thank you for your patience"

---

## 8. Archive & Documentation

**Goal:** Preserve the upgrade record for future reference and audits.

### 8.1 Create upgrade report

- [ ] Document this upgrade in a file named `UPGRADE_REPORT_v<NEW_VERSION>_<DATE>.md` in the `docs/` directory.
- [ ] Include:
  - Testnet results (duration, any issues, how resolved)
  - Mainnet deployment time and duration
  - Post-deployment verification results
  - Any rollbacks and their causes
  - Lessons learned and recommendations for the next upgrade

**Template:**
```markdown
# Upgrade Report: VERSION X → VERSION Y

**Date:** 2025-01-30
**Admin:** keeper-network-team

## Testnet
- Deployed: 2025-01-29 10:00 UTC
- Duration: 2 minutes
- Issues: None
- Keeper bots: 3/3 connected successfully
- Indexer: Updated schema, caught up in 5 minutes

## Mainnet
- Deployed: 2025-01-30 14:15 UTC
- Duration: <2 minutes
- Issues: None detected in first hour
- Keeper bots: traffic continuous, no errors
- Indexer: syncing normally

## Post-Deployment (24h)
- Task count: unchanged (1,234 → 1,234)
- Keeper reward calculations: correct
- Event throughput: normal

## Conclusion
Upgrade successful. No follow-up actions required.
```

### 8.2 Archive WASM binaries

- [ ] Store the new WASM and its hash in a long-term archive (git tag, artifact storage, or documentation):
  ```bash
  git tag -a v<VERSION>-mainnet-<DATE> \
    -m "KeeperRegistry VERSION <VERSION> mainnet deployment" \
    && git push origin v<VERSION>-mainnet-<DATE>
  ```

### 8.3 Update CHANGELOG

- [ ] Ensure [CHANGELOG.md](../CHANGELOG.md) documents this release with:
  - VERSION number
  - Date of release
  - New features and fixes
  - Storage-compatibility notes
  - Known issues (if any)

---

## Quick Reference Checklist

Print or bookmark this summary for quick reference during the upgrade:

- [ ] Storage compatibility test passes
- [ ] VERSION constant incremented
- [ ] WASM rebuilt and hashes verified
- [ ] Testnet upgrade: success + 24h monitoring passed
- [ ] Announcement published, stakeholders acknowledged
- [ ] Rollback plan tested (at least documented)
- [ ] Mainnet upgrade: deployment + 1-hour verification passed
- [ ] DEPLOYMENTS.md updated
- [ ] Upgrade report archived
- [ ] CHANGELOG.md updated

---

## Common Issues & Troubleshooting

### "Deserialization failed"
- **Cause:** New contract cannot read old on-chain state.
- **Fix:** Review storage compatibility (step 1). If incompatible, create a migration contract or redeploy with state export/re-import.

### "Indexer backlog growing"
- **Cause:** Indexer event parser doesn't recognize new event types.
- **Fix:** Update indexer schema, restart, allow catchup. See [INDEXER_DEPLOYMENT.md](INDEXER_DEPLOYMENT.md).

### "Keeper bots fail to claim after upgrade"
- **Cause:** Bot code hardcoded assumptions about task structure (should have been VERSION-agnostic).
- **Fix:** Update bot SDK or release a new bot binary. Announce timeline to community.

### "Rollback failed; can't read previous WASM"
- **Cause:** Previous WASM hash not saved before upgrade.
- **Fix:** Use Stellar network explorer to find the previous contract state and restore from archive.

---

## References

- [STORAGE_LAYOUT.md](STORAGE_LAYOUT.md) — on-chain state shape and compatibility analysis
- [DEPLOYMENTS.md](DEPLOYMENTS.md) — current deployment addresses and hashes
- [INDEXER_DEPLOYMENT.md](INDEXER_DEPLOYMENT.md) — indexer update procedures
- [constants.rs](../contracts/keeper-registry/src/constants.rs) — VERSION history and comments
- [admin.rs](../contracts/keeper-registry/src/admin.rs) — upgrade entry point implementation
