#!/usr/bin/env node
// Reports the minified + gzipped size of the SDK's bundled ESM output,
// mirroring the pattern .github/workflows/ci.yml's `wasm-size` job already
// established for the contract's WASM size (issue 0262 in the SDK epic):
// bundle, measure, compare against a committed baseline, report the delta.
//
// Usage: node scripts/report-bundle-size.mjs [--baseline] [--json]
//   --baseline  writes bundle-size-baseline.json instead of comparing against it
//   --json      prints machine-readable JSON instead of the human summary

import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(packageRoot, "bundle-size-baseline.json");

const args = process.argv.slice(2);
const writeBaseline = args.includes("--baseline");
const jsonOutput = args.includes("--json");

// Bundling (not just measuring dist/index.js on its own) matters here: the
// point of "bundle size" is what an application actually ships to a
// browser, which includes every non-external dependency pulled in by a
// real `import`. `@stellar/stellar-sdk` is marked external deliberately —
// it's a peer dependency an application already has its own copy of, so
// counting it here would double-count bytes the app pays for exactly once
// either way and would make this number dominated by a dependency this
// package doesn't control the size of at all.
async function bundleAndMeasure(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    external: ["@stellar/stellar-sdk", "@stellar/stellar-sdk/*"],
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].contents;
  const minifiedBytes = code.length;
  const gzippedBytes = gzipSync(code).length;
  return { minifiedBytes, gzippedBytes };
}

async function main() {
  const core = await bundleAndMeasure(
    path.join(packageRoot, "dist", "index.js"),
  );

  const report = {
    core: {
      minifiedBytes: core.minifiedBytes,
      gzippedBytes: core.gzippedBytes,
    },
  };

  if (writeBaseline) {
    writeFileSync(baselinePath, JSON.stringify(report, null, 2) + "\n");
    console.log(`Wrote baseline to ${baselinePath}`);
    return;
  }

  if (!existsSync(baselinePath)) {
    console.error(
      `No baseline found at ${baselinePath}. Run with --baseline to create one.`,
    );
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  if (jsonOutput) {
    console.log(JSON.stringify({ current: report, baseline }, null, 2));
    return;
  }

  const deltaBytes = report.core.gzippedBytes - baseline.core.gzippedBytes;
  const deltaPct =
    baseline.core.gzippedBytes === 0
      ? 0
      : (deltaBytes / baseline.core.gzippedBytes) * 100;

  console.log("### SDK bundle size (core client)\n");
  console.log("| Build | Bytes | KiB |");
  console.log("|-------|-------|-----|");
  console.log(
    `| minified | ${report.core.minifiedBytes} | ${(report.core.minifiedBytes / 1024).toFixed(1)} |`,
  );
  console.log(
    `| minified + gzip | ${report.core.gzippedBytes} | ${(report.core.gzippedBytes / 1024).toFixed(1)} |`,
  );
  console.log(
    `\nBaseline (\`bundle-size-baseline.json\`): **${baseline.core.gzippedBytes} bytes** (gzipped). Delta: **${deltaBytes >= 0 ? "+" : ""}${deltaBytes} bytes (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)**.`,
  );
  if (Math.abs(deltaPct) >= 10) {
    console.log(
      "\n**:warning: Bundle size changed by more than 10% relative to the baseline.** If this is intentional, update `bundle-size-baseline.json` (run `node scripts/report-bundle-size.mjs --baseline` after `npm run build`).",
    );
  }

  // `@stellar/stellar-sdk` is external (see bundleAndMeasure's comment), so
  // there is currently no separate React subpath to report — this package
  // has no React hooks at all yet (see this PR's description for the
  // disclosed scope gap against issue 0262's original ask).
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
