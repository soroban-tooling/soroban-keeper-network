module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", process: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", setImmediate: "readonly", AbortController: "readonly" },
    },
    rules: {
      // Keep the ruleset small and non-negotiable rather than stylistic. This
      // is an example bot read by newcomers; a wall of style errors on their
      // first `npm run lint` is not the welcome we want.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-undef": "error",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
  {
    // These tests are ES modules (node --test loads them by syntax).
    files: [
      "test/concurrency.test.js",
      "test/persistence.test.js",
      "test/profitability-boundary.test.js",
      "test/profitability-matrix.test.js",
      "test/v2-integration.test.js",
      "test/v2-regression.test.js",
    ],
    languageOptions: { sourceType: "module" },
  },
  {
    // Several test files carry unused fixtures/helpers kept for future cases.
    // Surface them without failing the required lint step.
    files: ["test/**/*.js"],
    rules: { "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }] },
  },
];
