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
