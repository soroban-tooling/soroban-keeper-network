"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { safeErrorMessage } = require("../index.js");

test("fatal errors never include a Stellar secret seed", () => {
  const secret = "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";
  const output = safeErrorMessage(new Error(`provider rejected KEEPER_SECRET_KEY=${secret}`));
  assert.equal(output.includes(secret), false);
  assert.match(output, /REDACTED/);
});
