#!/usr/bin/env node
// TypeScript's `module: "ES2020"` output does not append `.js` to relative
// import/export specifiers, but Node's ESM loader requires an explicit
// extension for a relative path (confirmed live: running the built
// `dist/esm` output under plain `node --test` threw `ERR_MODULE_NOT_FOUND`
// for exactly this reason before this script existed). Rather than switch
// the whole package to `NodeNext` module resolution — which would force
// every source file to write `.js`-suffixed relative imports even in
// pre-compiled `.ts`, a bigger and more invasive change than this scaffold
// warrants — this is a small, dependency-free post-build fixup: walk
// `dist/esm`, and append `.js` to every relative import/export specifier
// that doesn't already have an extension.
//
// Run as part of `npm run build:esm`, after `tsc` emits `dist/esm/**/*.js`.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const DIST_ESM_DIR = new URL("../dist/esm", import.meta.url).pathname;

// Matches `from "./x"` / `from "../x"` and the bare `import "./x"` form,
// capturing the quote character and the specifier. Deliberately does NOT
// match a bare package specifier (`from "react"`) or one that already has
// an extension (`from "./x.js"`) — re-running this script must be a no-op.
const RELATIVE_IMPORT_PATTERN = /((?:from|import)\s+["'])(\.\.?\/[^"'.]*(?:\.[a-zA-Z]+)?)(["'])/g;

function needsExtension(specifier) {
  return extname(specifier) === "";
}

function fixFile(filePath) {
  const original = readFileSync(filePath, "utf8");
  const fixed = original.replace(RELATIVE_IMPORT_PATTERN, (match, prefix, specifier, suffix) => {
    if (!needsExtension(specifier)) return match;
    return `${prefix}${specifier}.js${suffix}`;
  });
  if (fixed !== original) {
    writeFileSync(filePath, fixed, "utf8");
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath);
    } else if (entry.endsWith(".js")) {
      fixFile(fullPath);
    }
  }
}

walk(DIST_ESM_DIR);
