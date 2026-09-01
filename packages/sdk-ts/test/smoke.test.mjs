// Smoke test: confirms the built ESM output loads under `import`.
// Run after `npm run build` (see package.json's `test` script).

import test from "node:test";
import assert from "node:assert/strict";
import { SDK_VERSION } from "../dist/esm/index.js";

test("SDK_VERSION loads under import", () => {
  assert.equal(typeof SDK_VERSION, "string");
  assert.ok(SDK_VERSION.length > 0);
});
