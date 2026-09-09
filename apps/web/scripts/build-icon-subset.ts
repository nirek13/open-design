// Regenerate the Remix Icon subset that `src/styles/remixicon/remixicon-subset.css`
// serves on the fast path.
//
// Run from apps/web:
//   node --experimental-strip-types scripts/build-icon-subset.ts
//
// Emitting the .woff2 needs fontTools with brotli support, which is not a
// workspace dependency — the script writes the stylesheet itself and prints
// the one command to run for the font, rather than pretending the toolchain
// is always there:
//   python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
//
// Missing an icon here is not a correctness failure: the second @font-face in
// the generated stylesheet has no unicode-range, so any glyph outside the
// subset falls back to the complete font. The cost of a stale subset is one
// extra download, never a blank square.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDORED = join(WEB_ROOT, 'src/styles/remixicon/remixicon.css');
const OUTPUT = join(WEB_ROOT, 'src/styles/remixicon/remixicon-subset.css');

/** Every icon the vendored stylesheet defines, mapped to its codepoint. */
function iconCodepoints(): Map<string, string> {
  const css = readFileSync(VENDORED, 'utf8');
  const rule = /\.ri-([a-z0-9-]+):before\s*\{\s*content:\s*"\\([0-9a-fA-F]+)"/g;
  const found = new Map<string, string>();
  for (const match of css.matchAll(rule)) found.set(match[1], match[2]);
  return found;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'remixicon') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.(ts|tsx|css)$/.test(entry)) acc.push(path);
  }
  return acc;
}

/**
 * Icon names reachable from source. `RemixIcon` takes the bare name, so any
 * name written in the app appears as a complete quoted string — including the
 * lookup tables that feed the handful of non-literal call sites. Scanning for
 * quoted tokens over-collects harmlessly; it cannot silently under-collect a
 * name that is written down anywhere.
 */
function usedIconNames(defined: Map<string, string>): string[] {
  const blob = [join(WEB_ROOT, 'src'), join(WEB_ROOT, 'app')]
    .flatMap((dir) => sourceFiles(dir))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  const tokens = new Set<string>();
  for (const match of blob.matchAll(/["'`]([A-Za-z0-9-]{1,60})["'`]/g)) tokens.add(match[1]);
  for (const match of blob.matchAll(/\bri-([a-z0-9-]+)/g)) tokens.add(match[1]);

  return [...defined.keys()].filter((name) => tokens.has(name)).sort();
}

function wrapRanges(codepoints: string[]): string {
  const lines: string[] = [];
  let line = '';
  for (const point of codepoints) {
    if (line.length + point.length + 2 > 76) {
      lines.push(`    ${line.trimEnd()}`);
      line = '';
    }
    line += `${point}, `;
  }
  lines.push(`    ${line.trimEnd().replace(/,$/, '')}`);
  return lines.join('\n');
}

const defined = iconCodepoints();
const used = usedIconNames(defined);
const ranges = wrapRanges(used.map((name) => `U+${defined.get(name)}`));

const header = readFileSync(OUTPUT, 'utf8').split('@font-face')[0].trimEnd();
writeFileSync(
  OUTPUT,
  `${header}\n\n@font-face {\n  font-family: "remixicon-subset";\n`
  + `  src: url("/remixicon.subset.woff2") format("woff2");\n  font-display: swap;\n`
  + `  unicode-range:\n${ranges};\n}\n\n`
  + `@font-face {\n  font-family: "remixicon-subset";\n`
  + `  src: url("/remixicon.woff2") format("woff2");\n  font-display: swap;\n}\n\n`
  + `[class^="ri-"], [class*=" ri-"] {\n  font-family: "remixicon-subset" !important;\n}\n`,
);

console.log(`${used.length} of ${defined.size} icons used → ${relative(WEB_ROOT, OUTPUT)}`);
console.log('\nRebuild the font with:');
console.log(
  `  printf '%s\\n' ${used.map((n) => `U+${defined.get(n)}`).join(' ')} > /tmp/uc.txt`,
);
console.log(
  '  /tmp/fontenv/bin/pyftsubset public/remixicon.woff2 --unicodes-file=/tmp/uc.txt'
  + ' --flavor=woff2 --output-file=public/remixicon.subset.woff2',
);
