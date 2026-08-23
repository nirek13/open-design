// Turn a public URL into the same delimited text the spreadsheet importer
// already understands. The point of "magic import" is that a Google Sheet,
// a JSON API, or an HTML table should land in the ERP the same way a CSV
// drop does — preview the reading, then commit.
//
// Network stays behind `fetchExternalBrandAsset` so a pasted link cannot
// point the daemon at loopback or cloud metadata (same SSRF bar as brand
// harvest). Nothing here writes; callers pass the result to `buildImportPlan`.

import { fetchExternalBrandAsset } from '../brands/safe-fetch.js';
import { WorkspaceDataError } from './errors.js';

const FETCH_TIMEOUT_MS = 12_000;
const BODY_CAP = 2_000_000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type ImportSourceKind = 'csv' | 'json' | 'html-table' | 'google-sheets';

export interface FetchedImportSource {
  url: string;
  finalUrl: string;
  kind: ImportSourceKind;
  fileName: string;
  /** Delimited text ready for `buildImportPlan`. */
  content: string;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => csvEscape(cell)).join(',')).join('\n');
}

/** Public Google Sheets edit/view URLs become the CSV export equivalent. */
export function rewriteImportUrl(raw: string): { href: string; kind: ImportSourceKind | null } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new WorkspaceDataError('BAD_REQUEST', 400, 'that does not look like a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkspaceDataError('BAD_REQUEST', 400, 'only http(s) links can be imported');
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const sheet = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(parsed.pathname);
  if ((host === 'docs.google.com' || host === 'sheets.google.com') && sheet) {
    const id = sheet[1];
    const gid =
      parsed.searchParams.get('gid') ||
      /(?:^|#|&)gid=(\d+)/.exec(parsed.hash)?.[1] ||
      '0';
    if (/\/export(?:\/|$)/.test(parsed.pathname) || parsed.searchParams.get('output') === 'csv') {
      return { href: parsed.href, kind: 'google-sheets' };
    }
    return {
      href: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`,
      kind: 'google-sheets',
    };
  }
  return { href: parsed.href, kind: null };
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname;
    const base = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    if (base && /\.[a-z0-9]{1,8}$/i.test(base)) return base.slice(0, 80);
    if (base) return `${base.slice(0, 60)}.csv`;
  } catch {
    /* keep fallback */
  }
  return fallback;
}

function looksDelimited(text: string): boolean {
  const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  return [',', '\t', ';', '|'].some((d) => first.split(d).length > 1);
}

/** Flatten an array of objects (or `{data|records|items|rows: [...]}`) to CSV. */
export function jsonToCsv(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  let rows: unknown = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    rows =
      obj.data ??
      obj.records ??
      obj.items ??
      obj.rows ??
      obj.values ??
      (Object.keys(obj).length > 0 ? [obj] : null);
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const objects = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Array<
    Record<string, unknown>
  >;
  if (objects.length === 0) {
    const scalars = rows.map((row) => (row == null ? '' : String(row)));
    return rowsToCsv([['value'], ...scalars.map((value) => [value])]);
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
  return rowsToCsv([keys, ...objects.map((row) => keys.map((key) => cell(row[key])))]);
}

/** Pull the largest HTML `<table>` into CSV. */
export function htmlTableToCsv(html: string): string | null {
  const tables = [...html.matchAll(/<table\b[\s\S]{0,400000}?<\/table>/gi)].map((m) => m[0]);
  let best: string[][] | null = null;
  for (const table of tables) {
    const rows: string[][] = [];
    for (const rowMatch of table.matchAll(/<tr\b[\s\S]{0,20000}?<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
        const text = (cellMatch[1] ?? '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(text);
      }
      if (cells.some((cell) => cell !== '')) rows.push(cells);
    }
    if (rows.length >= 2 && (!best || rows.length > best.length)) best = rows;
  }
  return best ? rowsToCsv(best) : null;
}

function detectKind(
  contentType: string,
  body: string,
  hinted: ImportSourceKind | null,
): ImportSourceKind {
  if (hinted) return hinted;
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html-table';
  if (ct.includes('csv') || ct.includes('tab-separated')) return 'csv';
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/<table\b/i.test(body)) return 'html-table';
  return 'csv';
}

export async function fetchImportSource(
  url: string,
  fetchFn: typeof fetchExternalBrandAsset = fetchExternalBrandAsset,
): Promise<FetchedImportSource> {
  const rewritten = rewriteImportUrl(url);
  let res: Response;
  try {
    res = await fetchFn(rewritten.href, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/csv,text/tab-separated-values,application/json,text/html,text/plain,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WorkspaceDataError(
      'IMPORT_UNREADABLE',
      422,
      `could not fetch that link (${err instanceof Error ? err.message : 'network error'})`,
    );
  }
  if (!res.ok) {
    throw new WorkspaceDataError(
      'IMPORT_UNREADABLE',
      422,
      `the link answered ${res.status}; it needs to be publicly readable`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf.subarray(0, BODY_CAP).toString('utf8');
  if (!body.trim()) {
    throw new WorkspaceDataError('IMPORT_UNREADABLE', 422, 'that link was empty');
  }
  const kind = detectKind(res.headers.get('content-type') ?? '', body, rewritten.kind);
  let content = body;
  if (kind === 'json') {
    const csv = jsonToCsv(body);
    if (!csv) {
      throw new WorkspaceDataError(
        'IMPORT_UNREADABLE',
        422,
        'JSON needs an array of objects (or a data/records/items/rows field)',
      );
    }
    content = csv;
  } else if (kind === 'html-table') {
    const csv = htmlTableToCsv(body);
    if (!csv) {
      throw new WorkspaceDataError(
        'IMPORT_UNREADABLE',
        422,
        'no HTML table with a header and rows was found on that page',
      );
    }
    content = csv;
  } else if (!looksDelimited(body) && htmlTableToCsv(body)) {
    content = htmlTableToCsv(body)!;
  } else if (!looksDelimited(body) && jsonToCsv(body)) {
    content = jsonToCsv(body)!;
  }

  const finalUrl = res.url || rewritten.href;
  return {
    url: url.trim(),
    finalUrl,
    kind,
    fileName: fileNameFromUrl(finalUrl, kind === 'json' ? 'imported.json.csv' : 'imported.csv'),
    content,
  };
}
