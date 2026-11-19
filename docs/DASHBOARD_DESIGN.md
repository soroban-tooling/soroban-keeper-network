# Dashboard design

## Scope and stack

The dashboard is an operator-focused React 18 application in `apps/dashboard`, built with Vite and TypeScript. React Router owns client-side routes. Plain CSS uses a compact operations palette, responsive grid rules, and system light/dark preference. The production build is static and may be hosted on any CDN with history fallback to `index.html`.

The dashboard never becomes a second source of protocol truth. It reads historical and aggregate data from the indexer and reads authorization-sensitive current values from the contract immediately before displaying or mutating them.

## Routes and data sources

| Route | View | Indexer data | Contract data | Reason |
|---|---|---|---|---|
| `/tasks` | Task explorer | Paginated registrations and folded task state | None | Cursor pagination and filtering are historical/index concerns. |
| `/tasks/:taskId` | Task detail | Current indexed state and ordered event history | Claim lock fields when configured | History belongs to the indexer; action eligibility must reflect current contract state. |
| `/keepers` | Leaderboard | Executions, rewards, and reputation ranking | None | Every user must see the same deterministic ranking. |
| `/keepers/:keeper` | Keeper profile | Recent tasks | Balance, stake, pending unbond, reputation, and slash aggregate | Funds and eligibility must come from the authoritative contract. |
| `/stats` | Protocol statistics | Task counts, active keepers, and time series | Pause, fee basis points, and accrued fees | Trends require history; emergency and fee state must be current. |
| `/register` | Register task | None | Simulation, fee estimate, and signed submission | Validation and signing operate on current protocol rules. |

WebSocket `/v1/stream` messages invalidate task list and detail queries. The client resumes with the last observed cursor after an exponential-backoff reconnect and marks displayed data stale while disconnected.

## Wallet and signing

Freighter is the supported wallet for the first release. Read-only routes work without a wallet. Connecting authorizes the site, tracks selected-account changes, and compares the wallet network passphrase with the active dashboard network. A mismatch blocks transaction adapters and displays a persistent error. Disconnect clears dashboard state without claiming to revoke the extension's site permission.

The SDK simulates and assembles transactions before Freighter receives an XDR signing request. The register flow displays the assembled transaction fee before opening the signing prompt. No secret key or seed enters browser storage or application state.

## Network model

`src/config.tsx` defines testnet and mainnet presets. URLs and contract IDs come from `VITE_TESTNET_*` and `VITE_MAINNET_*` deployment variables. The selected network is stored locally, shown at all times, and mainnet uses a distinct amber indicator. Changing the selection reconstructs the indexer and contract clients so every route moves together.

## Hosting and security

Deploy `npm run build` output from `apps/dashboard/dist`. The host must provide TLS, a restrictive Content Security Policy, SPA history fallback, and no injected secrets. Contract IDs, RPC URLs, and indexer URLs are public configuration. Mainnet deployment remains blocked until [the readiness checklist](./MAINNET_READINESS.md) is complete.
