module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", process: "readonly", __dirname: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", BigInt: "readonly" },
    },
    rules: {
      // Same small, non-stylistic ruleset as examples/keeper-bot — this is an
      // example read by newcomers, and a wall of style errors on their first
      // `npm run lint` is not the welcome we want.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-undef": "error",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
];
