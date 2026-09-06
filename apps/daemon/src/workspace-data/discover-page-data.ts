// JS-rendered directories (YC companies, InstantSearch catalogs) ship an
// empty HTML shell and load rows from a public Algolia search index. Magic
// import follows that index with the page's search-only key — the same
// request the browser would make — instead of requiring a <table>.
//
// Network stays behind the caller's SSRF-safe fetch. Nothing here writes.

import type { fetchExternalBrandAsset } from '../brands/safe-fetch.js';
import { objectsToRows } from './extract-tabular.js';

const APP_ID = /^[A-Z0-9]{8,16}$/i;
const INDEX_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const HITS_PER_PAGE = 1000;
const MAX_HITS = 5000;
const MAX_INDEXES = 4;
const QUERY_TIMEOUT_MS = 20_000;

export interface AlgoliaSearchConfig {
  appId: string;
  apiKey: string;
  indexes: string[];
}

function uniqueIndexes(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!INDEX_NAME.test(trimmed) || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_INDEXES) break;
  }
  return out;
}

function indexesFromApiKey(apiKey: string): string[] {
  const blobs = [apiKey];
  try {
    const decoded = Buffer.from(apiKey, 'base64').toString('utf8');
    if (/restrictIndices=|analyticsTags=/.test(decoded)) blobs.push(decoded);
  } catch {
    /* keep the raw key */
  }
  const names: string[] = [];
  for (const blob of blobs) {
    const match = /restrictIndices=([^&]+)/.exec(blob);
    if (!match?.[1]) continue;
    try {
      names.push(...decodeURIComponent(match[1]).split(','));
    } catch {
      names.push(...match[1].split(','));
    }
  }
  return uniqueIndexes(names);
}

function indexesFromHtml(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(/\bindexName\s*:\s*["']([^"']+)["']/g)) {
    if (match[1]) names.push(match[1]);
  }
  return uniqueIndexes(names);
}

function extractBalanced(source: string, start: number): string | null {
  const open = source[start];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escape = false;
  const limit = Math.min(source.length, start + 20_000);
  for (let i = start; i < limit; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function readAlgoliaOpts(html: string): { appId: string; apiKey: string } | null {
  const assign = /(?:window\.)?AlgoliaOpts\s*=\s*(?=\{)/.exec(html);
  if (!assign) return null;
  const raw = extractBalanced(html, assign.index + assign[0].length);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const appId = String(parsed.app ?? parsed.appId ?? parsed.applicationID ?? '');
    const apiKey = String(parsed.key ?? parsed.apiKey ?? parsed.searchApiKey ?? '');
    if (APP_ID.test(appId) && apiKey.length >= 8) return { appId, apiKey };
  } catch {
    return null;
  }
  return null;
}

/** Pull a public Algolia search client out of the page HTML, if one is there. */
export function parseAlgoliaSearchConfig(html: string): AlgoliaSearchConfig | null {
  let appId = '';
  let apiKey = '';
  const opts = readAlgoliaOpts(html);
  if (opts) {
    appId = opts.appId;
    apiKey = opts.apiKey;
  }
  if (!appId || !apiKey) {
    const call = /algoliasearch\(\s*["']([A-Z0-9]{8,16})["']\s*,\s*["']([^"']{8,})["']/i.exec(html);
    if (call?.[1] && call[2]) {
      appId = call[1];
      apiKey = call[2];
    }
  }
  if (!appId || !apiKey) {
    const app =
      /["'](?:applicationID|appId|algoliaAppId)["']\s*:\s*["']([A-Z0-9]{8,16})["']/i.exec(html);
    const key =
      /["'](?:searchApiKey|apiKey|searchKey)["']\s*:\s*["']([^"']{16,})["']/i.exec(html);
    if (app?.[1] && key?.[1]) {
      appId = app[1];
      apiKey = key[1];
    }
  }
  if (!APP_ID.test(appId) || apiKey.length < 8) return null;
  const indexes = uniqueIndexes([...indexesFromApiKey(apiKey), ...indexesFromHtml(html)]);
  return { appId, apiKey, indexes };
}

function flattenHits(hits: unknown[]): unknown[] {
  return hits
    .filter((hit): hit is Record<string, unknown> => Boolean(hit) && typeof hit === 'object' && !Array.isArray(hit))
    .map((hit) => {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(hit)) {
        if (key.startsWith('_')) continue;
        row[key] = value;
      }
      return row;
    });
}

interface AlgoliaPage {
  hits: unknown[];
  nbPages: number;
}

async function queryAlgoliaPage(
  config: AlgoliaSearchConfig,
  indexName: string,
  page: number,
  fetchFn: typeof fetchExternalBrandAsset,
): Promise<AlgoliaPage | null> {
  const url = `https://${config.appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': config.appId,
        'X-Algolia-API-Key': config.apiKey,
      },
      body: JSON.stringify({ query: '', hitsPerPage: HITS_PER_PAGE, page }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { hits?: unknown; nbPages?: unknown };
    const hits = Array.isArray(json.hits) ? json.hits : [];
    const nbPages = typeof json.nbPages === 'number' && json.nbPages > 0 ? json.nbPages : 1;
    return { hits, nbPages };
  } catch {
    return null;
  }
}

/** Fetch rows from the page's public Algolia index, or null if none are usable. */
export async function fetchAlgoliaTable(
  html: string,
  fetchFn: typeof fetchExternalBrandAsset,
): Promise<string[][] | null> {
  const config = parseAlgoliaSearchConfig(html);
  if (!config || config.indexes.length === 0) return null;
  let chosen: AlgoliaPage | null = null;
  let chosenIndex: string | null = null;
  for (const indexName of config.indexes) {
    const first = await queryAlgoliaPage(config, indexName, 0, fetchFn);
    if (first && first.hits.length > 0) {
      chosen = first;
      chosenIndex = indexName;
      break;
    }
  }
  if (!chosen || !chosenIndex) return null;
  const hits = chosen.hits.slice();
  for (let page = 1; page < chosen.nbPages && hits.length < MAX_HITS; page += 1) {
    const next = await queryAlgoliaPage(config, chosenIndex, page, fetchFn);
    if (!next || next.hits.length === 0) break;
    hits.push(...next.hits);
  }
  return objectsToRows(flattenHits(hits.slice(0, MAX_HITS)));
}
