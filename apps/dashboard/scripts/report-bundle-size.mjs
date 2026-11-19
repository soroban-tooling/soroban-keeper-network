#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(__dirname, "..");
const distAssets = path.join(dashboardRoot, "dist", "assets");
const baselinePath = path.join(dashboardRoot, "bundle-size-baseline.json");

const args = process.argv.slice(2);
const writeBaseline = args.includes("--baseline");
const jsonOutput = args.includes("--json");

if (!existsSync(distAssets)) {
  console.error("dist/assets does not exist. Run 'npm run build' first.");
  process.exit(1);
}

const files = readdirSync(distAssets).filter((f) => f.endsWith(".js") || f.endsWith(".css"));

let totalRaw = 0;
let totalGzip = 0;
const chunks = [];

for (const file of files) {
  const filePath = path.join(distAssets, file);
  const content = readFileSync(filePath);
  const rawBytes = content.length;
  const gzippedBytes = gzipSync(content).length;

  totalRaw += rawBytes;
  totalGzip += gzippedBytes;

  // Normalize hashed names (e.g. index-D1muDZ5y.js -> index.js)
  const normalizedName = file.replace(/-[A-Za-z0-9_-]+\.(js|css)$/, ".$1");
  chunks.push({
    file,
    normalizedName,
    rawBytes,
    gzippedBytes,
  });
}

chunks.sort((a, b) => b.gzippedBytes - a.gzippedBytes);

const reportData = {
  timestamp: new Date().toISOString(),
  totalRawBytes: totalRaw,
  totalGzippedBytes: totalGzip,
  chunks: chunks.map((c) => ({
    name: c.normalizedName,
    rawBytes: c.rawBytes,
    gzippedBytes: c.gzippedBytes,
  })),
};

if (writeBaseline) {
  writeFileSync(baselinePath, JSON.stringify(reportData, null, 2) + "\n");
  console.log(`Updated baseline bundle size in ${baselinePath}`);
  process.exit(0);
}

if (jsonOutput) {
  console.log(JSON.stringify(reportData, null, 2));
  process.exit(0);
}

// Compare against baseline
let baseline = null;
if (existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    // Ignore corrupt baseline
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function formatDelta(current, prev) {
  if (!prev) return "—";
  const delta = current - prev;
  const pct = ((delta / prev) * 100).toFixed(1);
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatBytes(delta)} (${sign}${pct}%)`;
}

console.log("### Dashboard Bundle Size Report\n");
console.log(`| Chunk | Minified | Gzipped | Delta vs Baseline |`);
console.log(`| :--- | :---: | :---: | :---: |`);

for (const chunk of chunks) {
  const baseChunk = baseline?.chunks?.find((c) => c.name === chunk.normalizedName);
  const delta = formatDelta(chunk.gzippedBytes, baseChunk?.gzippedBytes);
  console.log(
    `| \`${chunk.normalizedName}\` | ${formatBytes(chunk.rawBytes)} | ${formatBytes(chunk.gzippedBytes)} | ${delta} |`
  );
}

console.log(
  `| **Total** | **${formatBytes(totalRaw)}** | **${formatBytes(totalGzip)}** | **${formatDelta(totalGzip, baseline?.totalGzippedBytes)}** |\n`
);

// Budget check: Total gzipped bundle budget 450 kB, initial explorer bundle < 25 kB
const BUDGET_TOTAL_GZIP = 450 * 1024;
const BUDGET_EXPLORER_GZIP = 25 * 1024;
const explorerChunk = chunks.find((c) => c.normalizedName === "index.js");

console.log("#### Performance Budget Assessment");
const totalPass = totalGzip <= BUDGET_TOTAL_GZIP;
console.log(
  `- Total bundle size budget: **${formatBytes(BUDGET_TOTAL_GZIP)}** → Actual: **${formatBytes(totalGzip)}** (${totalPass ? "PASS" : "EXCEEDED"})`
);

if (explorerChunk) {
  const explorerPass = explorerChunk.gzippedBytes <= BUDGET_EXPLORER_GZIP;
  console.log(
    `- Task Explorer entry budget: **${formatBytes(BUDGET_EXPLORER_GZIP)}** → Actual: **${formatBytes(explorerChunk.gzippedBytes)}** (${explorerPass ? "PASS" : "EXCEEDED"})`
  );
}
