# React hooks worked example

A minimal Vite + React app composing `@soroban-keeper-network/sdk/react`'s
hooks: a live task feed (`useTaskEvents`), a register-task form
(`useRegisterTask`), and a keeper-balance widget with a withdraw button
(`useKeeperBalance`, plus the plain SDK client for the withdraw call — see
[`../../docs/REACT_GUIDE.md`](../../docs/REACT_GUIDE.md) for why that one
isn't a hook). `src/App.tsx` is the starting point — it wires up
`KeeperRegistryProvider` once and everything else reads that same client.

## Run it

```bash
npm install
cp .env.example .env
npm run dev
```

`.env.example`'s placeholder values are format-valid, so the app starts and
the read hooks (`useTaskEvents`, `useKeeperBalance`) render without edits —
against a placeholder contract id they'll just show empty/zero results
rather than erroring. **Read `.env.example`'s comments before changing
`VITE_DEMO_SECRET_KEY`**: this demo signs with a secret key baked into the
browser bundle for simplicity, which is fine for a key you generate
yourself for local exploration and never for a real account.

## Other scripts

```bash
npm run build     # tsc --noEmit, then a production Vite build
npm run preview   # serve that production build locally
```
