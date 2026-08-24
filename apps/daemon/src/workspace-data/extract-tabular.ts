// Turn messy public HTML into a CSV-shaped table when the page has any
// repeating structure: <table>, definition lists, cards, JSON-LD, Next.js
// payloads, markdown grids, ARIA grids, or a list of similar items.
//
// Magic import should not require the source to already be a spreadsheet.
// Callers pick the strongest candidate; nothing here writes.

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => csvEscape(cell)).join(',')).join('\n');
}

function objectsToRows(rows: unknown[]): string[][] | null {
  if (rows.length === 0) return null;
  const objects = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Array<
    Record<string, unknown>
  >;
  if (objects.length === 0) {
    if (rows.every((row) => row == null || typeof row !== 'object')) {
      return [['value'], ...rows.map((row) => [row == null ? '' : String(row)])];
    }
    if (rows.every((row) => Array.isArray(row))) {
      return (rows as unknown[][]).map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
    }
    return null;
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of objects) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  if (keys.length === 0) return null;
  const cell = (value: unknown): string => {
    if (value == null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  return [keys, ...objects.map((row) => keys.map((key) => cell(row[key])))];
}

function findTabularArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value) && value.length > 0) {
    if (value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return value;
    if (value.every((row) => row == null || typeof row !== 'object')) return value;
    if (value.every((row) => Array.isArray(row))) return value;
    for (const entry of value) {
      const nested = findTabularArray(entry, depth + 1);
      if (nested && nested.length >= MIN_ROWS) return nested;
    }
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.edges)) {
    const nodes = obj.edges
      .map((edge) => (edge && typeof edge === 'object' ? (edge as { node?: unknown }).node : null))
      .filter(Boolean);
    if (nodes.length >= MIN_ROWS) return nodes;
  }
  const preferred = [
    'data',
    'records',
    'items',
    'itemListElement',
    'rows',
    'values',
    'results',
    'nodes',
    'entries',
    'hits',
    'content',
    'list',
    'collection',
    'products',
    'users',
    'orders',
    'invoices',
    'customers',
  ];
  for (const key of preferred) {
    const found = findTabularArray(obj[key], depth + 1);
    if (found) return found;
  }
  let best: unknown[] | null = null;
  for (const nested of Object.values(obj)) {
    const found = findTabularArray(nested, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

function jsonToRows(raw: string): string[][] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = findTabularArray(parsed);
  return rows ? objectsToRows(rows) : null;
}

function jsonToCsv(raw: string): string | null {
  const rows = jsonToRows(raw);
  return rows ? rowsToCsv(rows) : null;
}

const MIN_ROWS = 2;
const MIN_COLS = 2;

function decodeEntities(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '\n');
}

function scoreRows(rows: string[][]): number {
  if (rows.length < MIN_ROWS) return 0;
  const cols = Math.max(...rows.map((row) => row.length));
  if (cols < 1) return 0;
  const filled = rows.reduce((n, row) => n + row.filter((cell) => cell.trim()).length, 0);
  const widthBonus = cols >= MIN_COLS ? cols * 4 : 1;
  return rows.length * widthBonus + filled;
}

function pickBest(candidates: Array<string[][] | null>): string[][] | null {
  let best: string[][] | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const next = scoreRows(candidate);
    if (next > bestScore) {
      best = candidate;
      bestScore = next;
    }
  }
  return bestScore > 0 ? best : null;
}

function htmlTables(html: string): string[][] | null {
  const tables = [...html.matchAll(/<table\b[\s\S]{0,500000}?<\/table>/gi)].map((m) => m[0]);
  const candidates: string[][][] = [];
  for (const table of tables) {
    const rows: string[][] = [];
    for (const rowMatch of table.matchAll(/<tr\b[\s\S]{0,30000}?<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
        cells.push(decodeEntities(cellMatch[1] ?? ''));
      }
      if (cells.some((cell) => cell !== '')) rows.push(cells);
    }
    if (rows.length >= MIN_ROWS) candidates.push(normalizeWidth(rows));
  }
  return pickBest(candidates);
}

function normalizeWidth(rows: string[][]): string[][] {
  const cols = Math.max(...rows.map((row) => row.length), 0);
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < cols) next.push('');
    return next;
  });
}

function definitionLists(html: string): string[][] | null {
  const lists = [...html.matchAll(/<dl\b[\s\S]{0,200000}?<\/dl>/gi)].map((m) => m[0]);
  const candidates: string[][][] = [];
  for (const list of lists) {
    const rows: string[][] = [['name', 'value']];
    const items = [...list.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)];
    for (const item of items) {
      const name = decodeEntities(item[1] ?? '');
      const value = decodeEntities(item[2] ?? '');
      if (name || value) rows.push([name, value]);
    }
    if (rows.length >= MIN_ROWS + 1) candidates.push(rows);
  }
  return pickBest(candidates);
}

function markdownTables(html: string): string[][] | null {
  const text = decodeEntities(stripScripts(html).replace(/<\/(p|div|h[1-6]|li)>/gi, '\n'));
  const blocks = text.split(/\n{2,}/);
  const candidates: string[][][] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('|'));
    if (lines.length < 2) continue;
    const parsed = lines
      .filter((line) => !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line))
      .map((line) =>
        line
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim()),
      )
      .filter((row) => row.some((cell) => cell !== ''));
    if (parsed.length >= MIN_ROWS) candidates.push(normalizeWidth(parsed));
  }
  return pickBest(candidates);
}

function ariaGrid(html: string): string[][] | null {
  const rows: string[][] = [];
  for (const rowMatch of html.matchAll(/role=["']row["'][\s\S]{0,20000}?(?=role=["']row["']|<\/(table|div|section)>|$)/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/role=["'](?:columnheader|gridcell|cell)["'][^>]*>([\s\S]*?)<\//gi)) {
      cells.push(decodeEntities(cellMatch[1] ?? ''));
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells);
  }
  return rows.length >= MIN_ROWS ? normalizeWidth(rows) : null;
}

function jsonLdTables(html: string): string[][] | null {
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const candidates: string[][][] = [];
  for (const script of scripts) {
    const rows = jsonToRows(script[1] ?? '');
    if (rows && rows.length >= MIN_ROWS) candidates.push(normalizeWidth(rows));
  }
  return pickBest(candidates);
}

function embeddedJson(html: string): string[][] | null {
  const chunks: string[] = [];
  const next = /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (next?.[1]) chunks.push(next[1]);
  const nuxt = /<script\b[^>]*>[\s\S]*?window\.__NUXT__\s*=\s*({[\s\S]*?});[\s\S]*?<\/script>/i.exec(html);
  if (nuxt?.[1]) chunks.push(nuxt[1]);
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (script[1]) chunks.push(script[1]);
  }
  const candidates: string[][][] = [];
  for (const chunk of chunks) {
    const rows = jsonToRows(chunk);
    if (rows && rows.length >= MIN_ROWS) candidates.push(normalizeWidth(rows));
  }
  return pickBest(candidates);
}

function preformatted(html: string): string[][] | null {
  const blocks = [...html.matchAll(/<(pre|code)\b[^>]*>([\s\S]{20,200000}?)<\/\1>/gi)].map((m) =>
    decodeEntities(m[2] ?? ''),
  );
  const candidates: string[][][] = [];
  for (const block of blocks) {
    const markdown = markdownTables(`<p>${block}</p>`);
    if (markdown) candidates.push(markdown);
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length >= MIN_ROWS && lines.filter((line) => /[,;\t|]/.test(line)).length >= MIN_ROWS) {
      const delim = [',', '\t', ';', '|'].sort(
        (a, b) =>
          lines[0]!.split(b).length - lines[0]!.split(a).length,
      )[0]!;
      const rows = lines.map((line) => line.split(delim).map((cell) => cell.trim()));
      if (Math.max(...rows.map((row) => row.length)) >= MIN_COLS) candidates.push(normalizeWidth(rows));
    }
  }
  return pickBest(candidates);
}

function repeatingCards(html: string): string[][] | null {
  const articleLike =
    /<(article|li|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const groups = new Map<string, string[][]>();
  let match: RegExpExecArray | null;
  const source = stripScripts(html);
  while ((match = articleLike.exec(source))) {
    const attrs = match[2] ?? '';
    const className = /class=["']([^"']+)["']/.exec(attrs)?.[1]?.split(/\s+/).slice(0, 2).join('.') ?? match[1]!;
    const inner = match[3] ?? '';
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(inner);
    const price = /(?:price|amount|total|cost)[^<]{0,40}([$\d][\d,.]*)/i.exec(inner);
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(inner);
    const fields: string[] = [
      decodeEntities(heading?.[1] ?? link?.[2] ?? ''),
      decodeEntities(price?.[1] ?? ''),
      decodeEntities(link?.[1] ?? ''),
    ];
    const extra = [...inner.matchAll(/<(p|span|dd|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((m) => decodeEntities(m[2] ?? ''))
      .filter((text) => text && text.length < 120)
      .slice(0, 4);
    const row = [...fields, ...extra].filter((cell, index, all) => cell && all.indexOf(cell) === index);
    if (row.length < MIN_COLS) continue;
    const bucket = groups.get(className) ?? [];
    bucket.push(row);
    groups.set(className, bucket);
  }
  const candidates = [...groups.values()]
    .filter((rows) => rows.length >= MIN_ROWS)
    .map((rows) => {
      const cols = Math.max(...rows.map((row) => row.length));
      const header = Array.from({ length: cols }, (_, i) =>
        i === 0 ? 'name' : i === 1 ? 'value' : i === 2 ? 'url' : `col_${i + 1}`,
      );
      return normalizeWidth([header, ...rows]);
    });
  return pickBest(candidates);
}

function lists(html: string): string[][] | null {
  const blocks = [...html.matchAll(/<(ul|ol)\b[\s\S]{0,300000}?<\/\1>/gi)].map((m) => m[0]);
  const candidates: string[][][] = [];
  for (const block of blocks) {
    const items = [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => decodeEntities(m[1] ?? ''));
    const split = items
      .map((item) => {
        const parts = item.split(/\s[—–\-:|]\s/).map((part) => part.trim()).filter(Boolean);
        return parts.length >= 2 ? parts.slice(0, 6) : [item];
      })
      .filter((row) => row.some((cell) => cell !== ''));
    if (split.length < 3) continue;
    const cols = Math.max(...split.map((row) => row.length));
    if (cols < 2 && split.length < 8) continue;
    const header = cols >= 2 ? ['name', ...Array.from({ length: cols - 1 }, (_, i) => `col_${i + 2}`)] : ['value'];
    candidates.push(normalizeWidth([header, ...split]));
  }
  return pickBest(candidates);
}

/** Best tabular reading of an HTML document, or null if nothing looks like rows. */
export function extractTabularFromHtml(html: string): string | null {
  const rows = pickBest([
    htmlTables(html),
    jsonLdTables(html),
    embeddedJson(html),
    markdownTables(html),
    ariaGrid(html),
    definitionLists(html),
    repeatingCards(html),
    lists(html),
    preformatted(html),
  ]);
  if (!rows) {
    const csv = jsonToCsv(html);
    return csv && csv.includes('\n') ? csv : null;
  }
  return rowsToCsv(rows);
}
