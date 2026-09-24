const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

// Keeper bot v2 follows the same minimal lint philosophy as the main SDK:
// a small, non-negotiable ruleset focused on correctness and clarity,
// not extensive style enforcement.
module.exports = [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
];
