# Dashboard Security Review: Transaction-Signing Flows

This security review audits every write and transaction-signing flow offered by the Soroban Keeper Network web dashboard (`apps/dashboard`), evaluating user display transparency, network validation, simulation safety, and replay protection.

---

## 1. Scope & Signing Flows

The dashboard offers seven distinct transaction-signing interactions across task owners and keepers:

| Flow | Component | Target Contract | Action | Authorization |
| :--- | :--- | :--- | :--- | :--- |
| **Register Task** | `RegisterTask.tsx` | `keeper-registry` | `register_task` | Owner |
| **Increase Reward** | `OwnerActions.tsx` | `keeper-registry` | `increase_reward` | Owner |
| **Extend Deadline** | `OwnerActions.tsx` | `keeper-registry` | `extend_deadline` | Owner |
| **Cancel Task** | `OwnerActions.tsx` | `keeper-registry` | `cancel_task` | Owner |
| **Withdraw Rewards** | `KeeperActions.tsx` | `keeper-registry` | `withdraw_rewards` | Keeper |
| **Deposit Stake** | `KeeperActions.tsx` | `keeper-registry` | `stake` | Keeper |
| **Unbond Stake** | `KeeperActions.tsx` | `keeper-registry` | `unbond` | Keeper |
| **Withdraw Stake** | `KeeperActions.tsx` | `keeper-registry` | `withdraw_stake` | Keeper |

---

## 2. Per-Flow Audit: Display Transparency Before Signing

### 2.1 Register Task (`RegisterTask.tsx`)
- **What the user sees before signing:**
  - Target contract address (`C...`)
  - Target function name (e.g. `rebalance`)
  - Calldata arguments as formatted JSON array
  - Escrow reward in tokens and stroops (positive integer)
  - Absolute deadline timestamp formatted in local and UTC time
  - Optional verifier contract address (`C...`)
  - **Simulated fee**: Estimated network fee in stroops displayed before the wallet prompt is triggered.
- **Pre-flight verification:**
  - Validates connected account matches a valid Ed25519 public key.
  - Validates contract targets and verifiers with `StrKey.isValidContract`.
  - Enforces calldata length ceiling (`MAX_CALLDATA_BYTES = 1024`).
  - Calls `operations.estimateRegisterTask` to simulate execution on Soroban RPC before requesting wallet signature.

### 2.2 Increase Reward (`OwnerActions.tsx`)
- **What the user sees before signing:**
  - Task ID
  - Current escrow reward
  - Additional bounty input (in tokens/stroops)
  - Estimated new total reward
  - Warning that funds will be deducted from connected account upon signing.
- **Pre-flight verification:**
  - Checks connected account equals task `owner`.
  - Verifies additional reward amount is strictly positive.
  - Verifies task status is `pending` or `claimed` (not executed, cancelled, or expired).

### 2.3 Extend Deadline (`OwnerActions.tsx`)
- **What the user sees before signing:**
  - Task ID
  - Current deadline (relative time and absolute date)
  - New proposed deadline timestamp
- **Pre-flight verification:**
  - Confirms proposed deadline is strictly greater than current deadline and greater than current time.
  - Verifies contract is not paused and task remains active.

### 2.4 Cancel Task (`OwnerActions.tsx`)
- **What the user sees before signing:**
  - Task ID
  - Explicit confirmation modal explaining that escrowed rewards will be refunded to the owner.
  - Warning that cancellation is irreversible.
- **Pre-flight verification:**
  - Verifies caller is task owner.
  - Verifies task is currently in `pending` status (unclaimed).

### 2.5 Keeper Staking & Withdrawals (`KeeperActions.tsx`)
- **What the user sees before signing:**
  - Current withdrawable balance and available stake.
  - Exact amount to deposit, unbond, or claim.
  - Unbonding lock delay in ledgers.
- **Pre-flight verification:**
  - Checks positive non-zero amounts.
  - Verifies unbonding delay has elapsed before allowing `withdraw_stake`.

---

## 3. Threat Analysis & Safeguards

### 3.1 Network Mismatch & Cross-Chain Replay
- **Threat:** User signs a transaction intended for Testnet while their wallet is connected to Mainnet (or vice versa), causing unintended fund transfers.
- **Safeguard:**
  `WalletProvider` continuously monitors Freighter's active network passphrase via `WatchWalletChanges`. If `walletNetwork.networkPassphrase` does not match the active dashboard configuration (`network.passphrase`), all signing buttons are disabled, and a persistent `wrongNetwork` alert banner is displayed.

### 3.2 Misleading Displays & Obfuscated Payloads
- **Threat:** User is shown human-readable parameters that differ from the encoded XDR envelope submitted to the wallet.
- **Safeguard:**
  Transaction envelopes are constructed using the `@soroban-keeper-network/sdk` TypeScript builders directly from validated input states. Calldata parameters are encoded into explicit `ScVal` primitives (`addressArg`, `i128Arg`, `u64Arg`, `bytesArg`) without intermediary mutations.

### 3.3 Transaction Simulation Before Prompt
- **Threat:** User signs a transaction that immediately fails on-chain, wasting gas fees and leaving contract state unchanged.
- **Safeguard:**
  Every write flow executes `simulateTransaction` on the Soroban RPC node prior to invoking `signTransaction`. If contract simulation reverts or produces an authorization error, the error message is displayed to the user and the wallet prompt is aborted.

### 3.4 Frontrunning & Double Execution
- **Threat:** Stale transactions are submitted or replayed.
- **Safeguard:**
  Stellar ledger transactions include sequence numbers tied to the signer account, making replays invalid once a sequence number is consumed. Furthermore, Soroban ledger footprint bounds ensure storage isolation.

---

## 4. Security Findings & Disposition

| ID | Severity | Finding | Disposition |
| :--- | :--- | :--- | :--- |
| **SEC-DASH-01** | Medium | User could submit registration without pre-flight fee visibility | **Fixed**: Two-phase "Estimate fee" → "Sign and register" flow implemented. |
| **SEC-DASH-02** | High | Cross-network transaction submission if wallet switched networks mid-session | **Fixed**: `WalletProvider` listens to `WatchWalletChanges` and halts signing when passphrase mismatches. |
| **SEC-DASH-03** | Low | Unchecked large calldata payloads could exceed Soroban transaction size limits | **Fixed**: Enforced `MAX_CALLDATA_BYTES` (1024 bytes) pre-flight check in `RegisterTask.tsx`. |
| **SEC-DASH-04** | Info | Wallet extension site disconnect does not revoke browser permission | **Accepted**: Inherent to EIP-1193 / Freighter extension architecture. UI clears session state cleanly. |

---

## 5. Conclusion

The dashboard signing flows adhere to strict display transparency and verification requirements. All write actions require explicit user intent, enforce network passphrase synchronization, simulate execution before prompting signatures, and provide clear plain-language parameter summaries.
