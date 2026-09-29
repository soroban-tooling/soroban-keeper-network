const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

// Mirrors packages/sdk-ts's eslint.config.cjs: a small, non-negotiable
// ruleset rather than a wall of style rules.
module.exports = [
  {
    ignores: ["src/generated/**"],
  },
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
