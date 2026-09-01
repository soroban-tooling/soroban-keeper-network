// Smoke test: confirms the built CJS output loads under `require`.
// Run after `npm run build` (see package.json's `test` script).

const test = require("node:test");
const assert = require("node:assert/strict");
const { SDK_VERSION } = require("../dist/cjs/index.js");

test("SDK_VERSION loads under require()", () => {
  assert.equal(typeof SDK_VERSION, "string");
  assert.ok(SDK_VERSION.length > 0);
});
