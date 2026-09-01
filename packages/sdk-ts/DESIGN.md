# TypeScript SDK Design

## Overview

The TypeScript SDK provides a typed client for the keeper-registry contract, enabling dApps to register, claim, and execute automation tasks with proper type safety, error handling, and ergonomic transaction builders.

---

## Decision: Generated Bindings vs Hand-Written Client

### Evaluation of Generated Bindings

The Soroban CLI's `stellar contract bindings typescript` generator produces TypeScript clients directly from a contract's WASM. For the keeper-registry contract, the generator would produce:

**Generated Client Shape (Example Excerpt):**
```typescript
export interface KeeperRegistry {
  register_task: (params: {
    owner: Address;
    task_type: TaskType;
    calldata: Bytes;
    reward: i128;
    deadline: u64;
    ttl_ledgers: u32;
    lock_ledgers: u32;
  }) => Promise<u64 | SorobanRpcErrorResponse>;
  
  claim_task: (params: {
    keeper: Address;
    task_id: u64;
  }) => Promise<Result<void, KeeperError> | RpcError>;
  
  get_task: (task_id: u64) => Promise<Task | RpcError>;
  // ... etc for all 20+ contract methods
}
```

**Findings:**

1. **Basic Method Typing** ✓
   - The generator produces correctly typed method signatures matching the contract's actual Rust interface.
   - Parameter types (Address, i128, u64, Bytes, enums) are properly reflected.
   - Return types are available.

2. **Error Typing** ✗
   - The generator treats errors generically: caught exceptions are wrapped in RPC error objects, not typed `KeeperError` discriminants.
   - Raw error codes (numeric discriminants 1–23) are buried in RPC response details, not exposed as a typed enum.
   - A caller must parse error responses manually: not ergonomic for the requirement in issue #0166 (typed error decoding).

3. **Transaction Building** ✗
   - The generator produces only individual method stubs.
   - Each method internally simulates and submits a transaction—the whole dance is hidden.
   - Cannot expose unsigned XDR for wallet-signing flows (issue #0170 requirement).
   - Cannot offer pre-submission simulation previews (issue #0171 requirement).
   - No transaction builder abstraction for composing or inspecting transactions before submission.

4. **React Hook Friendliness** ✗
   - The generated methods are raw async functions, not React hooks.
   - No built-in state management for mutations, queries, or polling (issues #0173–0178 requirements).
   - Hooks like `useRegisterTask`, `useTask`, `useClaimTask` require hand-written layers over the generated base.

5. **Maintenance Burden**
   - Generated bindings must be regenerated whenever the contract changes (method signature updates, new methods, error code additions).
   - A stale generator output can silently misrepresent the contract's ABI (e.g., if error discriminants are added but not regenerated).
   - No CI check enforces regeneration synchronization with contract updates—requires manual discipline.

6. **Dependency Coupling**
   - Locks the SDK to Soroban CLI version compatibility.
   - Generator output quality and API stability depend on Soroban CLI's maintenance roadmap.

### Evaluation of Hand-Written Client

A hand-written client directly implements the keeper-registry ABI with full control over ergonomics, type safety, and extensibility.

**Design Pattern (Core Example):**
```typescript
export class KeeperRegistryClient {
  constructor(private params: ClientConfig) {}

  async registerTask(input: RegisterTaskInput): Promise<{ taskId: u64; proof: TransactionResult }> {
    const unsignedXdr = this.buildTransaction('register_task', input);
    const signedXdr = await this.signer(unsignedXdr);
    const result = await this.submitTransaction(signedXdr);
    return { taskId: result.returnValue, proof: result };
  }

  async buildTransaction(method: string, params: any): Promise<string> {
    // Unsigned XDR for wallet-signing flows
  }

  async submitSignedTransaction(signedXdr: string): Promise<TransactionResult> {
    // Submit pre-signed transaction
  }

  // Typed error decoder
  private decodeError(rpcError: RpcError): KeeperError | undefined {
    const code = extractErrorCode(rpcError);
    return code in KeeperErrorCode ? KeeperErrorCode[code] : undefined;
  }
}
```

**Findings:**

1. **Typed Error Handling** ✓
   - Define a `KeeperErrorCode` enum with all 23 discriminants from `errors.rs`.
   - A `decodeError` helper maps numeric error codes to typed enum values.
   - Clients can pattern-match on specific errors (e.g., `if (err === KeeperErrorCode.LockPeriodActive)`).
   - Keeps error definitions synchronized with contract via issue #0192's versioning policy.

2. **Transaction Building** ✓
   - Expose `buildTransaction(method, params): Promise<UnsignedXdr>` for wallet-signing flows.
   - Expose `submitSignedTransaction(signedXdr)` to complete the flow.
   - Wrapper methods (`registerTask`, etc.) become convenience layers for the secret-key case.
   - Meets issues #0170 (unsigned XDR) and #0171 (simulation preview) requirements.

3. **React Hook Friendliness** ✓
   - Build React hooks directly on top of the client: `useRegisterTask`, `useTask`, etc. (issues #0173–#0178).
   - Hooks can wrap the client's methods with standard mutation/query patterns (loading state, error handling, caching).
   - Full control over state management—no dependency on a third-party generator's hook API.

4. **Maintainability Considerations**
   - The ABI is stable: all 23 error codes and method signatures are stable as of the MVP release. Changes are tracked in `CHANGELOG.md` and backlog issues.
   - Method signatures are explicit in this codebase (no code generation to keep in sync).
   - Error discriminants must be manually updated when new errors are added, but this is intentional: a keeper-bot author should explicitly review each new error type when it lands (see issue #0192's versioning policy).
   - No external CLI dependency—builds with only `@stellar/stellar-sdk`.

5. **Ergonomics**
   - Can optimize transaction building for keeper-bot patterns (e.g., batch simulations, retry logic).
   - Can provide domain-specific helper types (e.g., `RegisterTaskInput` with validation, numeric precision helpers for i128).
   - Can include examples and docs inline in TypeScript (JSDoc).

### Comparison Against Epic E12 Requirements

| Requirement | Generated | Hand-Written |
|---|---|---|
| Typed errors (issue #0166) | ✗ | ✓ |
| Unsigned XDR / wallet signing (issue #0170) | ✗ | ✓ |
| Simulation preview (issue #0171) | ✗ | ✓ |
| React hooks (issues #0173–#0178) | ✗ (requires wrapper) | ✓ |
| Transaction builders (issues #0170–#0171) | ✗ | ✓ |
| Ergonomics in keeper-bot example (issue #0194) | Fair | Excellent |
| Maintenance burden | Medium (regeneration) | Low (static, stable ABI) |
| External dependency coupling | CLI version | None |

---

## Decision

**Chosen: Hand-Written Client**

The Soroban CLI-generated bindings do not meet the ergonomic requirements for typed error handling, transaction builders, and React hooks that epic E12 depends on. While the generated output provides basic type safety for method signatures, a hand-written client built directly against the contract's ABI offers:

1. **Full control over typing**: Typed `KeeperErrorCode` enum for all 23 error discriminants, with a decoder helper (issue #0166).
2. **Transaction builder patterns**: Separation of unsigned-XDR building from submission, enabling wallet-signing flows (issues #0170, #0171).
3. **React hook support**: Direct hooks without a third-party abstraction layer (issues #0173–#0178).
4. **Minimal maintenance**: The keeper-registry ABI is stable in the MVP; method signatures and error codes are explicit in this repo and tracked via `CHANGELOG.md`.
5. **No external CLI dependency**: Builds with only `@stellar/stellar-sdk`, reducing toolchain complexity.

The generated bindings can be revisited in a later phase (e.g., for a community-contributed alt-SDK) but do not unblock E12's core deliverables.

---

## Workflow: Manual ABI Synchronization

Since the hand-written client is not auto-generated, the following process ensures it stays in sync with the contract:

### 1. On Contract Changes

When the contract's `lib.rs` interface changes (new methods, modified error codes, type updates):

1. **Review the change** — Contract PRs must declare which SDK methods are affected (or if new ones are needed).
2. **Update the SDK** — Modify `packages/sdk-ts/src/` to reflect the new ABI.
3. **Update error enum** — If new error discriminants are added to `KeeperError` (enum variants in `errors.rs`), reflect them in `packages/sdk-ts/src/errors.ts`.
4. **Increment versioning** — Follow issue #0192's versioning policy: SDK version must be incremented to match or reference the contract's `VERSION`.
5. **Add a test** — Issue #0180 (integration tests) or #0181 (unit tests with mocked RPC) should cover the new method or error.

### 2. CI Check: Version Alignment

A CI job (part of issue #0186, npm publish workflow) verifies that:
- The SDK's published `version` in `package.json` matches or is compatible with the deployed contract's `VERSION`.
- This prevents a published SDK from claiming support for a contract version whose ABI it doesn't actually match.

### 3. Documentation

- **`packages/sdk-ts/DESIGN.md`** (this file) — explains why we chose hand-written and how to maintain it.
- **`packages/sdk-ts/src/errors.ts`** — comments listing the error discriminants and their sources in `contracts/keeper-registry/src/errors.rs`.
- **`CHANGELOG.md`** — SDK changelog entries link to contract changes that triggered SDK updates (e.g., "SDK v0.2.0: added `updateVerifier` method, requires contract v0.2.0+").

### 4. Manual Review Checklist for Future Changes

When a contract-impacting PR lands, reviewers can use this checklist:

- [ ] Does the contract change (new method, renamed field, new error) affect the SDK's public API?
- [ ] If yes, is there a linked PR on the SDK side, or is it documented as "SDK must update in next wave"?
- [ ] If adding a new error, is it added to both `contracts/keeper-registry/src/errors.rs` AND `packages/sdk-ts/src/errors.ts` with matching discriminants?
- [ ] Is `CHANGELOG.md` updated to note the SDK/contract version alignment requirement?

---

## Rationale: Why Not Use the Generator

1. **Incomplete typing**: Generic error handling does not meet issue #0166's requirement for a typed `KeeperErrorCode` enum.
2. **No transaction builders**: The generator hides all transaction details; exposing unsigned XDR and simulation (issues #0170–#0171) would require post-processing the generated output—adding a hand-written layer anyway.
3. **React hooks out of scope**: The Soroban CLI generator does not produce hooks; issue #0173+ requires custom hooks on top of whatever base exists.
4. **Stable ABI**: The keeper-registry MVP is feature-complete and unlikely to change method signatures frequently. Manual sync is a reasonable trade-off.
5. **Simplicity**: One less external CLI dependency, easier onboarding for new contributors, and no "regeneration dance" in CI.

---

## Future Considerations

- **Alternative Generator**: If Soroban CLI's TypeScript generator improves to include typed error enums and transaction builder patterns, this decision can be revisited for future SDKs or contract versions.
- **SDK Maturity**: Once the SDK reaches a stable 1.0 release (all epic E12 issues complete), a community-maintained "generator wrapper" could be built on top if desired, without changing the core decision.
- **Cross-Checks**: Integration tests (issue #0180) should periodically verify that the SDK's method signatures and error codes actually match the deployed contract, catching any drift early.
