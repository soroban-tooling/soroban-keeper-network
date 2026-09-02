---
title: "feat(sdk-ts-react): KeeperRegistryProvider context and useKeeperRegistryClient hook"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0153]
---

## Summary

Opens the React-hooks slice of this epic. Rather than every hook constructing its own `KeeperRegistryClient`, a context provider supplies one shared instance, configured once at the app root — the standard pattern for a React SDK wrapping a stateful client object.

## Expected behaviour

A separate entry point (`@soroban-keeper-network/sdk/react`, so consumers who don't use React aren't forced to pull in a React dependency) exporting `<KeeperRegistryProvider contractId={} rpcUrl={} networkPassphrase={}>` and `useKeeperRegistryClient()` returning the configured client instance from context, throwing a clear error if used outside the provider.

## Acceptance criteria

- [ ] React is a peer dependency, not a direct dependency, of the core SDK package — confirm the package.json split (core vs `/react` subpath or separate package) does not force non-React consumers to install React.
- [ ] `useKeeperRegistryClient()` outside the provider throws a clear, actionable error rather than `undefined` silently propagating into a later crash.
- [ ] A minimal test using React Testing Library confirms the provider/hook pair works.

## Notes on Wallet Integration Pattern

As defined in issue 0170 (`transactionBuilder.ts`), browser React hooks should use `client.buildTransaction(methodName, params)` to obtain unsigned XDR + required `signers`, pass the XDR to the user's connected wallet hook for signing, and call `client.submitSignedTransaction(signedXdr)` to submit. The SDK never requires private keys in browser applications.

## Files

- packages/sdk-ts/src/react/provider.tsx
- packages/sdk-ts/src/react/index.ts

