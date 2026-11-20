#!/usr/bin/env node
// Stage the repository's Markdown into docs/site/src so mdBook can build it.
//
// The documentation is not moved: docs/*.md and the per-package READMEs stay
// where they are (so `git log --follow` keeps working). This script copies
// them into docs/site/src/ (gitignored) at build time and rewrites relative
// links so they resolve inside the site, or point at the file on GitHub when
// the target is not part of the site (source code, scripts, workflows, ...).
//
// It fails if a staged page is missing from src/SUMMARY.md, or if SUMMARY.md
// links to a page that was not staged, so the navigation cannot drift.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SITE, "..", "..");
const SRC = path.join(SITE, "src");
const BLOB = "https://github.com/soroban-tooling/soroban-keeper-network/blob/main";

// Authored pages that live in src/ and are not copied from elsewhere.
const AUTHORED = new Set(["SUMMARY.md", "index.md"]);

// Pages that are not under docs/: repo-relative source -> path inside src/.
const EXTRA = {
  "examples/README.md": "examples.md",
  "examples/batch-register/README.md": "packages/batch-register.md",
  "examples/keeper-bot-v2/README.md": "packages/keeper-bot-v2.md",
  "examples/keeper-bot-v2/DEPLOYMENT.md": "packages/keeper-bot-v2-deployment.md",
  "packages/cli/README.md": "packages/cli.md",
  "packages/sdk-ts/README.md": "packages/sdk-ts.md",
  "packages/indexer-client/README.md": "packages/indexer-client.md",
  "rust-sdk/README.md": "packages/rust-sdk.md",
  "indexer/README.md": "packages/indexer.md",
};

const posix = (p) => p.split(path.sep).join("/");

// repo-relative source path -> staged path (relative to src/)
const map = new Map();
for (const f of fs.readdirSync(path.join(ROOT, "docs")).sort()) {
  if (f.endsWith(".md")) map.set(`docs/${f}`, f);
}
for (const [from, to] of Object.entries(EXTRA)) {
  if (!fs.existsSync(path.join(ROOT, from))) {
    console.error(`stage: extra page ${from} does not exist`);
    process.exit(1);
  }
  map.set(from, to);
}

function rewriteLinks(text, fromRepoPath, stagedPath) {
  let inFence = false;
  const fix = (target) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
    const [rawPath, ...fragParts] = target.split("#");
    if (!rawPath) return target;
    const frag = fragParts.length ? `#${fragParts.join("#")}` : "";
    const resolved = posix(
      path.normalize(path.join(path.dirname(fromRepoPath), decodeURI(rawPath))),
    );
    if (resolved.startsWith("..")) return target;
    if (map.has(resolved)) {
      const rel = posix(path.relative(path.dirname(stagedPath), map.get(resolved)));
      return `${rel || path.basename(stagedPath)}${frag}`;
    }
    return `${BLOB}/${resolved}${frag}`;
  };
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, a, t, c) => a + fix(t) + c)
        .replace(/^(\s*\[[^\]]+\]:\s+)(\S+)/, (_, a, t) => a + fix(t));
    })
    .join("\n");
}

// Remove previously staged files (everything except the authored pages).
for (const entry of fs.readdirSync(SRC)) {
  if (!AUTHORED.has(entry)) fs.rmSync(path.join(SRC, entry), { recursive: true, force: true });
}

for (const [from, to] of map) {
  const dest = path.join(SRC, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const text = fs.readFileSync(path.join(ROOT, from), "utf8");
  fs.writeFileSync(dest, rewriteLinks(text, from, to));
}

// Cross-check navigation against what was staged.
const summary = fs.readFileSync(path.join(SRC, "SUMMARY.md"), "utf8");
const listed = new Set([...summary.matchAll(/\]\(([^)#\s]+)/g)].map((m) => m[1]));
const staged = new Set([...map.values(), ...AUTHORED].filter((p) => p !== "SUMMARY.md"));
const missing = [...staged].filter((p) => !listed.has(p));
const dangling = [...listed].filter((p) => !staged.has(p));
if (missing.length || dangling.length) {
  if (missing.length) console.error(`stage: pages not in SUMMARY.md: ${missing.join(", ")}`);
  if (dangling.length) console.error(`stage: SUMMARY.md links to unknown pages: ${dangling.join(", ")}`);
  process.exit(1);
}
console.log(`stage: staged ${map.size} pages into docs/site/src`);
