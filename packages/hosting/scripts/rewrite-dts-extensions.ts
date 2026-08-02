// Rewrite `./x.ts` imports to `./x.js` in the emitted declarations.
//
// The source deliberately imports with explicit `.ts` extensions so the
// Supabase edge functions (Deno) can load `src/*.ts` directly and run the same
// bytes the daemon runs. `tsc --emitDeclarationOnly` carries those specifiers
// through verbatim, but `dist/` contains `slug.d.ts`, not `slug.ts`, so a Node
// consumer resolving `./slug.ts` finds nothing.
//
// `rewriteRelativeImportExtensions` does not cover declaration output, so this
// closes the gap: `./slug.js` resolves to `./slug.d.ts` under every module
// resolution mode we support.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const RELATIVE_TS_IMPORT = /(from\s+["']\.{1,2}\/[^"']+?)\.ts(["'])/g;

async function* declarationFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* declarationFiles(full);
    else if (entry.name.endsWith(".d.ts")) yield full;
  }
}

let rewritten = 0;
for await (const file of declarationFiles(distDir)) {
  const before = await readFile(file, "utf8");
  const after = before.replace(RELATIVE_TS_IMPORT, "$1.js$2");
  if (after !== before) {
    await writeFile(file, after);
    rewritten += 1;
  }
}

console.log(`rewrote .ts import specifiers in ${rewritten} declaration file(s)`);
