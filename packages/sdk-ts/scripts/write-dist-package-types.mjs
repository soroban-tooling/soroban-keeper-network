// The package is `"type": "module"`, so Node would read dist/cjs/*.js as ESM
// without an explicit override. Dropping a one-line package.json into each
// output directory is the standard way to label the two builds; doing it here
// rather than by hand keeps `npm run build` reproducible from a clean tree.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");

for (const [dir, type] of [
  ["esm", "module"],
  ["cjs", "commonjs"],
]) {
  const target = join(dist, dir);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`);
}
