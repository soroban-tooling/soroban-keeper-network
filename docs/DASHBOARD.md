# Soroban Keeper Network Dashboard

The Soroban Keeper Network Dashboard (`apps/dashboard`) is an operator-focused web application for inspecting network health, browsing and filtering registered tasks, tracking keeper leaderboards, reviewing protocol parameters, and registering custom keeper tasks on Stellar Soroban.

---

## 1. Architecture & Security Model

The dashboard is built with **React 18**, **TypeScript**, and **Vite**.

- **No Server-Side State**: The application compiles to static HTML, CSS, and JavaScript. All live contract reads query the Soroban RPC directly or via the event indexer service.
- **Client-Side Signing**: Private keys never touch the web server or application memory. All transaction signing flows delegate to browser wallets (such as Freighter) via standard Stellar interfaces.
- **Strict Content Security Policy (CSP)**: Outlined below to prevent Cross-Site Scripting (XSS) and unauthorized data exfiltration.
- **Zero Third-Party Trackers**: No analytics scripts, tracking pixels, or remote CDNs are loaded at runtime.

---

## 2. Content Security Policy (CSP)

To safeguard wallet connections and prevent unauthorized script injection, the dashboard enforces a strict CSP via HTTP headers or `<meta http-equiv="Content-Security-Policy">` in `apps/dashboard/index.html`:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.stellar.org https://soroban-testnet.stellar.org https://*.soroban-rpc.com http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'self';
```

### Directive Breakdown
- `default-src 'self'`: Restricts all unspecified resource types to the application's origin.
- `script-src 'self'`: Only permits first-party scripts packaged in the build output. Disallows `eval()` and remote external scripts.
- `style-src 'self' 'unsafe-inline'`: Permits local stylesheets and dynamic inline CSS variables used for theme toggling.
- `img-src 'self' data:`: Permits first-party images and inline SVG icons.
- `connect-src`: Restricts network communication (`fetch`, `WebSocket`) exclusively to:
  - Official Stellar testnet/mainnet RPC endpoints (`https://*.stellar.org`, `https://soroban-testnet.stellar.org`)
  - Permitted Soroban RPC infrastructure (`https://*.soroban-rpc.com`)
  - Local development indexer and RPC services (`http://localhost:*`, `http://127.0.0.1:*`)
- `object-src 'none'`: Blocks Flash, Java applets, and other plugin objects.
- `base-uri 'self'` / `form-action 'self'`: Prevents URL base manipulation and external form submissions.

---

## 3. Self-Hosting Static Files

The dashboard can be hosted on any static web server, CDN, or object storage service.

### 3.1 Building Static Assets
Ensure the TypeScript SDK is built first, then compile the dashboard:

```bash
cd packages/sdk-ts && npm run build
cd ../../apps/dashboard && npm install && npm run build
```

The production output is generated in `apps/dashboard/dist/`.

### 3.2 Nginx Configuration
Because the application uses client-side routing (React Router HTML5 history mode), all page requests must fall back to `index.html`:

```nginx
server {
    listen 80;
    server_name dashboard.keeper.network;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dashboard.keeper.network;

    ssl_certificate /etc/letsencrypt/live/dashboard.keeper.network/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dashboard.keeper.network/privkey.pem;

    root /var/www/dashboard/dist;
    index index.html;

    # Security Headers
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.stellar.org https://soroban-testnet.stellar.org https://*.soroban-rpc.com http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'self';" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # Cache static assets with content hashes
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA routing fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 3.3 Caddy Configuration
```caddy
dashboard.keeper.network {
    root * /var/www/dashboard/dist
    file_server

    header {
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.stellar.org https://soroban-testnet.stellar.org https://*.soroban-rpc.com http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'self';"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    }

    try_files {path} /index.html
}
```

### 3.4 Cloudflare Pages / AWS S3 + CloudFront
1. Set the build command to `npm run build` with root directory `apps/dashboard`.
2. Set output directory to `dist`.
3. Configure redirect rule: `/* -> /index.html` (HTTP status 200).

---

## 4. CI/CD Deployment Pipeline

The dashboard deployment workflow is defined in `.github/workflows/dashboard-deploy.yml`:

- **Production Deployments (`main` branch only)**:
  Every push merged to `main` triggers an automated build that publishes to the production environment on GitHub Pages. Pull requests cannot deploy to production.
- **Preview Builds (Pull Requests)**:
  Pull requests that modify `apps/dashboard/`, `packages/sdk-ts/`, or `packages/indexer-client/` trigger a preview build job that compiles and uploads `dashboard-dist` as a workflow artifact for validation prior to merge.

---

## 5. Performance & Bundle Budget

The dashboard enforces a strict performance budget:
- **Task Explorer Entry Chunk (`index.js`)**: Under 25 kB gzipped.
- **Total Combined Bundle**: Under 450 kB gzipped across all code-split vendor and page chunks.
- **Baseline Tracking**: Monitored on every build via `scripts/report-bundle-size.mjs` against `bundle-size-baseline.json`.

---

## 6. Operator & User Guide

The dashboard provides a dedicated UI for both **Task Owners** (dApps, DAOs, traders registering and financing automation) and **Keepers** (bot operators claiming and executing tasks for rewards).

### 6.1 Navigation & Global Controls

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [●] Soroban Keeper Network   [Tasks] [Keepers] [Stats] [Treasury] [Admin] [Register]    │
│ [🔍 Search tasks, keepers, owners... ]    [Testnet ▼]  [🌙]  [👛 Connected: GD7A...3KQ]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Network Selector**: Switch between Testnet and Mainnet (Mainnet displays an amber warning badge). All queries and contract adapters update instantly.
- **Global Search**: Type-ahead search indexing task IDs, contract addresses, keeper addresses, and owner accounts.
- **Wallet Connection**: Connect via Freighter. Read-only exploration works without a wallet; write operations require connection.
- **Theme Toggle**: Switch between system, light, and dark modes.

---

### 6.2 Task Explorer (`/tasks`)

The primary entry point for monitoring network activity.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Tasks Explorer                                                    [+ Register New Task]│
│ Filter: [All (1,248)]  [Pending (34)]  [Claimed (6)]  [Executed (1,180)]  [Cancelled]  │
├────────┬──────────────────────┬─────────────┬──────────────┬─────────────┬─────────────┤
│ ID     │ Target Contract      │ Function    │ Reward (XLM) │ Status      │ Deadline    │
├────────┼──────────────────────┼─────────────┼──────────────┼─────────────┼─────────────┤
│ #1042  │ CB62...LIQUIDITY_POOL│ extend_ttl  │ 0.0500 XLM   │ [● Pending] │ In 42 ledg  │
│ #1041  │ CA44...ORACLE_ROUTER │ update_feed │ 0.1200 XLM   │ [● Claimed] │ Lock: 8 ledg│
│ #1040  │ CD19...VESTING_VAULT │ release     │ 0.0250 XLM   │ [✔ Executed]│ Block 849201│
│ #1039  │ CC88...SUBSCRIPTION  │ execute_pay │ 0.0100 XLM   │ [✔ Executed]│ Block 849180│
└────────┴──────────────────────┴─────────────┴──────────────┴─────────────┴─────────────┘
  Showing 1 - 25 of 1,248 tasks                       [◄ Previous]  [Page 1 of 50]  [Next ►]
```

- **Status Badges**:
  - `Pending`: Eligible for keeper claims (if attached conditions evaluate to true).
  - `Claimed`: Claimed by a keeper under an active lock window.
  - `Executed`: Successfully completed; reward disbursed to keeper.
  - `Expired`: Deadline elapsed without execution; owner may cancel to refund reward.
  - `Cancelled`: Terminated by task owner.
- **Sorting & Filters**: Filter by status, target contract, or owner address.

---

### 6.3 Task Detail View (`/tasks/:taskId`)

Detailed view of a single task's lifecycle, on-chain state, condition gating, and execution proof.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Task #1042                                                         [Back to Explorer]  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Target Contract:  CB62...LIQUIDITY_POOL                Owner:  GB89...OWNER_ACCOUNT    │
│ Target Function:  extend_ttl                           Status: [● Pending]             │
│ Reward Deposited: 0.0500 XLM (500,000 Stroops)         Deadline: Ledger 849,500        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Attached Condition (Epic E10/E11):                                                     │
│ Address: CC42...PRICE_THRESHOLD_CONDITION               Type: Price Threshold           │
│ Current Evaluation: [✔ SATISFIED] (Oracle Price: $0.152 >= Threshold: $0.150)         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Claim Lock Status:                                                                     │
│ Unclaimed — Any registered keeper may simulate and claim this task.                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Owner Quick Actions (Owner Wallet GD89... Only):                                       │
│ [ ⚡ Increase Reward ]    [ ⏳ Extend Deadline ]    [ 🚫 Cancel Task & Refund ]        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.4 Register Task Flow (`/register`)

Task owners deposit rewards and schedule automated contract calls.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Register Automation Task                                                               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Target Contract Address *                                                              │
│ [ CB62DAPPSTOREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX                 ]            │
│ Function Name *                                                                        │
│ [ extend_ttl                                                              ]            │
│ Arguments (JSON Array or ScVal XDR)                                                    │
│ [ [500, 10000]                                                            ]            │
│ Reward Amount (XLM) *                                                                  │
│ [ 0.05                                              ] (500,000 Stroops)                │
│ Execution Deadline (Ledgers from now) *                                                │
│ [ 1000                                              ] (~83 minutes)                    │
│ Attached Condition Contract (Optional)                                                 │
│ [ CC42CONDITIONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX                 ]            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Simulation & Pre-Flight Review:                                                        │
│ Protocol Base Fee:  0.0010 XLM            Estimated Gas Fee: 0.0015 XLM                │
│ Total Upfront Deposit: 0.0510 XLM         Simulation Result: [✔ SUCESS (Ready to Sign)]│
│                                                                                        │
│                               [ Sign & Submit via Freighter ]                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Parameter Entry**: Enter target contract ID, function name, arguments, reward, and deadline.
2. **Pre-flight Simulation**: Automatically validates contract existence, argument types, and balance sufficiency before prompt.
3. **Freighter Sign Submission**: Signs and broadcasts the registration transaction.

---

### 6.5 Keeper Leaderboard (`/keepers`)

Ranks active keeper bots competing on the network.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Keeper Leaderboard                                                Active Keepers: 48   │
├──────┬──────────────────────┬────────────┬──────────────┬──────────────┬───────────────┤
│ Rank │ Keeper Address       │ Executions │ Success Rate │ Total Earned │ Bonded Stake  │
├──────┼──────────────────────┼────────────┼──────────────┼──────────────┼───────────────┤
│ #1   │ GA99...KEEPER_ALPHA  │ 4,120 txs  │ 99.8%        │ 245.50 XLM   │ 5,000.00 XLM  │
│ #2   │ GB33...BOT_RUNNER_2  │ 3,890 txs  │ 99.4%        │ 210.25 XLM   │ 2,500.00 XLM  │
│ #3   │ GC77...FAST_KEEPER   │ 2,450 txs  │ 98.9%        │ 145.00 XLM   │ 1,000.00 XLM  │
│ #4   │ GD12...SOLO_NODE     │ 1,120 txs  │ 99.1%        │  78.20 XLM   │   500.00 XLM  │
└──────┴──────────────────────┴────────────┴──────────────┴──────────────┴───────────────┘
```

- **Executions**: Total successful tasks executed.
- **Success Rate**: Ratio of claimed tasks executed on time without slashing or lock expiration.
- **Bonded Stake**: Active security bond deposited in the registry.

---

### 6.6 Keeper Profile & Operator Actions (`/keepers/:keeper`)

Individual keeper dashboard for managing bonds and withdrawing earned rewards.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Keeper Profile: GA99...KEEPER_ALPHA                                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Status: [● Active]        Reputation Score: 98.4/100       Slash Count: 0              │
│ Bonded Stake: 5,000.00 XLM                                 Pending Unbond: 0.00 XLM    │
│ Accrued Rewards: 42.8500 XLM                               Available to Claim: 42.85   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Operator Actions (GA99... Wallet Only):                                                │
│ [ 💰 Withdraw Earned Rewards ]   [ 🔒 Deposit Stake Bond ]   [ 🔓 Request Unbond ]     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Withdraw Earned Rewards**: Transfers accumulated task rewards from the contract to the keeper wallet.
- **Deposit Stake Bond**: Increases bonded security collateral to qualify for higher-value tasks.
- **Request Unbond**: Initiates the unbonding cooldown period before stake can be withdrawn.

---

### 6.7 Protocol Owner Operations (`/owners/:owner`)

Management dashboard for dApp and protocol owners who sponsor tasks.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Owner Dashboard: GB89...OWNER_ACCOUNT                                                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Total Registered Tasks: 84           Active / Pending: 12        Completed: 72         │
│ Total Rewards Sponsored: 14.50 XLM   Active Escrow: 1.20 XLM                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Managed Tasks:                                                                         │
│ Task #1042: CB62...extend_ttl (Reward: 0.05 XLM) ── [ + Increase Reward ] [ ✕ Cancel ] │
│ Task #1038: CA11...rebalance  (Reward: 0.10 XLM) ── [ ⏳ Extend Deadline ] [ ✕ Cancel ]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Increase Reward**: Adds additional reward tokens to attract keepers when network gas prices surge.
- **Extend Deadline**: Pushes back the expiration ledger sequence.
- **Cancel Task**: Cancels an unclaimed or expired task and refunds deposited reward tokens to the owner.

---

### 6.8 Protocol Statistics (`/stats`)

Network-wide health and throughput telemetry.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Protocol Metrics & Telemetry                                      Status: [● Healthy]  │
├──────────────────────────┬──────────────────────────┬──────────────────────────────────┤
│ 24h Executions:  842 txs │ Active Keepers: 48 nodes │ Total Value Locked: 14,250 XLM   │
│ Avg Latency: 1.8 ledgers │ Success Ratio:  99.6%    │ Total Protocol Fees: 89.20 XLM   │
├──────────────────────────┴──────────────────────────┴──────────────────────────────────┤
│ Execution Throughput (Last 7 Days)                                                     │
│  Txs │                                                                                 │
│ 1000 ┼               ╭──╮                                                              │
│  800 ┼         ╭─────╯  ╰─╮       ╭──╮                                                 │
│  600 ┼   ╭─────╯          ╰───────╯  ╰──                                               │
│  400 ┼───╯                                                                             │
│      └───────────────────────────────────                                              │
│         Mon   Tue   Wed   Thu   Fri   Sat                                              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.9 Treasury & Admin Views (`/treasury` & `/admin`)

Read-only transparency views for governance and protocol parameters:
- **/treasury**: Protocol fee accruals, reserve balance, and historical community disbursements.
- **/admin**: Emergency pause status (`false`), authorized controllers, minimum stake requirements, and current basis point protocol fee rates.
