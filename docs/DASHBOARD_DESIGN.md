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

---

## Epic E17 Retrospective: Shipped vs Deferred

Epic E17 delivered the first production-ready operator web interface for the Soroban Keeper Network. Below is the retrospective accounting for every capability scoped in this design document against the final shipped release.

### What Shipped

1. **Core Exploration & Navigation (PR #915, #916, #920)**:
   - Paginated `/tasks` explorer with live status indicators (`Pending`, `Claimed`, `Executed`, `Cancelled`, `Expired`).
   - Detailed `/tasks/:taskId` view with raw argument inspection, timeline tracking, and claim lock details.
   - Global `/keepers` leaderboard ranking active operators by executions and reputation.
   - Authoritative `/keepers/:keeper` profile reading live balances, stake, and pending unbond status directly from the contract.
   - Global type-ahead search across task IDs, contracts, keepers, and owner addresses.

2. **Protocol Owner & Admin Operations (PR #915, #918)**:
   - Dedicated `/owners/:owner` dashboard allowing task sponsors to manage active escrows.
   - In-app write flows: Increase Reward, Extend Deadline, and Cancel Task & Refund.
   - Read-only `/admin` panel displaying protocol parameters, emergency pause status, and fee basis points.
   - Read-only `/treasury` view surfacing protocol reserve balances and historical disbursements.

3. **Wallet Connection & Transaction Security (PR #918, #923)**:
   - Freighter browser wallet integration.
   - Pre-flight transaction simulation via `@soroban-keeper-network/sdk`.
   - Clear display of fee amounts, recipient addresses, and parameter disclosures prior to user signing prompt.
   - Network mismatch guard preventing transaction submission if the wallet network passphrase diverges from the dashboard's active network.

4. **Production Architecture & Performance (PR #922, #923)**:
   - WCAG 2.1 AA accessibility compliance across all forms, tables, modals, and contrast ratios.
   - Comprehensive test suite: 15 Vitest component unit suites (58 tests) + Playwright E2E and Axe accessibility audits.
   - Static hosting deployment workflow (`.github/workflows/dashboard-deploy.yml`) with automated PR preview artifacts.
   - Strict Content Security Policy (`default-src 'self'`) blocking CDNs, external scripts, and data exfiltration.
   - Route code-splitting with `React.lazy()` and manual vendor chunking keeping initial Task Explorer load at 17.80 kB gzipped (budget: 25 kB) and total bundle at 309.43 kB gzipped (budget: 450 kB).

### Divergences and Deferrals

To maintain strict security guarantees and prevent reliance on unhardened network protocols in v1, the following items from the initial design were adapted or deferred:

1. **WebSocket `/v1/stream` Live Cursor Invalidation (Deferred)**:
   - *Design Proposal*: Establish a persistent WebSocket connection to `/v1/stream` on the indexer to invalidate cache queries in real time.
   - *Shipped Implementation*: The dashboard uses interval-based indexer polling with exponential backoff on reconnection failure.
   - *Rationale for Deferral*: The production indexer deployment required additional load-testing under high concurrency before opening unbounded WebSocket connections to client browsers. Polling provides deterministic consistency without holding open socket state. Full WebSocket streaming is scheduled for Epic E21.

2. **Multi-Wallet Support Beyond Freighter (Deferred)**:
   - *Design Proposal*: Support multi-wallet connectors (Albedo, xBull, WalletConnect, WebAuthn Passkeys).
   - *Shipped Implementation*: Only Freighter is supported in v1.
   - *Rationale for Deferral*: Freighter has the most robust testnet/mainnet passphrase matching API, enabling the dashboard to guarantee network alignment. Multi-wallet abstraction via the Stellar Wallets Kit is deferred to a future milestone after wallet-standard alignment.

3. **Direct Ledger Streaming via Horizon SSE (Divergence / Rejected)**:
   - *Design Decision*: Direct connection to Horizon SSE streams was rejected in favor of reading exclusively from the Soroban RPC and the indexer REST API.
   - *Rationale*: Horizon SSE does not carry folded contract storage entries and imposes high client-side CPU overhead parsing raw ledger transaction envelopes.

4. **Batch Owner Operations (Deferred to Epic E20)**:
   - *Design Proposal*: Batch canceling or batch increasing rewards across multiple tasks in a single multi-call transaction.
   - *Shipped Implementation*: Actions are currently executed per task ID.
   - *Rationale for Deferral*: Requires client-side assembly of Soroban smart contract batch calls which are planned under Epic E20.
