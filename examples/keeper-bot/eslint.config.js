module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", process: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly" },
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
];
