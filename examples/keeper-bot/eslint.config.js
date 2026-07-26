"use strict";

// Flat config — ESLint 9 no longer reads .eslintrc.*. The bot is a CommonJS
// Node script, so declare that source type explicitly rather than relying on
// the default (module), which would flag every `require` as a parse error.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // The example logs progress to stdout by design.
      "no-console": "off",
      // Ignore intentionally-unused error bindings and leading args.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
