---
title: "chore(keeper-bot): add the ESLint config that npm run lint and CONTRIBUTING both reference"
labels: [keeper-bot, tooling, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

`package.json` defines `"lint": "eslint ."` and `eslint` is a devDependency, but no ESLint configuration file exists. CONTRIBUTING points contributors at a specific path for it. The file is not there, so the lint script does not work.

## Current state

`examples/keeper-bot/package.json`:

```json
"scripts": {
  "start": "node index.js",
  "lint": "eslint ."
},
"devDependencies": {
  "eslint": "^9.0.0"
}
```

CONTRIBUTING, under Code Style:

> **Linting**: ESLint with the config in `examples/keeper-bot/.eslintrc.json`.

The directory contains only `.env.example`, `index.js`, and `package.json`. There is no `.eslintrc.json`, no `eslint.config.js`, and no `eslintConfig` key in `package.json`.

ESLint 9 defaults to flat config and looks for `eslint.config.js`. With no config present it exits with an error rather than linting anything — so `npm run lint` fails for every contributor who follows CONTRIBUTING.

CI currently tolerates this: the bot job is advisory and the lint step uses `--if-present`, which checks whether the *script* exists, not whether it works. So the failure is invisible in CI and only surfaces locally.

Note that CONTRIBUTING names `.eslintrc.json`, the ESLint 8 format. Adding that filename would be following the documentation into a deprecated format; the config should be flat and CONTRIBUTING should be corrected.

## Expected behaviour

`npm run lint` runs and reports on the bot source. CONTRIBUTING names the file that actually exists.

## Suggested approach

Add `examples/keeper-bot/eslint.config.js` in flat format:

```js
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
```

Run it and expect real findings — `xdr` and `Address` are imported and never used, and `fetchPendingTasks` contains an empty catch block. Those are tracked in a separate issue. Decide whether to fix them here or leave the lint failing until that PR lands, and say which in the PR description. Leaving CI red, even advisorily, is the worse option.

Match the style choices to the code that exists rather than importing a preferred config wholesale. The bot is deliberately CommonJS and deliberately not TypeScript, per CONTRIBUTING.

## Acceptance criteria

- [ ] A flat-format ESLint config exists in `examples/keeper-bot/`.
- [ ] `npm run lint` runs successfully from that directory.
- [ ] The ruleset is documented with a comment explaining the "correctness over style" intent.
- [ ] CONTRIBUTING names the correct filename and format.
- [ ] The bot source is lint-clean, or the remaining findings are explicitly deferred to the named issue.
- [ ] The CI bot job runs the lint step and surfaces the output.

## Files

- `examples/keeper-bot/eslint.config.js` — new
- `examples/keeper-bot/package.json`
- `CONTRIBUTING.md`
- `.github/workflows/ci.yml`

## Getting started

Good first issue and a satisfying one — it fixes a broken instruction in the contributor documentation, which is the first thing a new contributor hits.
