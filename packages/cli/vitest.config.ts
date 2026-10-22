import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The CLI's tests run against the SDK's *source* and its fake RPC
  // (`packages/sdk-ts/test/support`), so they need neither a built SDK nor a
  // network. `dedupe` forces the SDK's own `@stellar/stellar-sdk` imports onto
  // this package's single copy; two copies would make `instanceof xdr.ScVal`
  // checks inside the fake RPC fail across the boundary.
  resolve: {
    alias: {
      "@soroban-keeper-network/sdk": here("../sdk-ts/src/index.ts"),
    },
    dedupe: ["@stellar/stellar-sdk"],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
