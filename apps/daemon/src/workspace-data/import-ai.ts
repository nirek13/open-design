// When a public page is not already a spreadsheet, ask a small model to
// read the visible text and return rows. Heuristic table/JSON/card extractors
// run first; this is the fallback so a pricing page or directory can still
// become a table.
//
// Network for the page itself stays in `fetchImportSource`. This module only
// talks to an OpenAI-compatible chat endpoint, and only when a key is already
// configured. Tests inject `extractWithAi` so CI never needs a live model.

import { readEnvOpenAiApiKey, ENV_OPENAI_DEFAULT_BASE_URL, ENV_OPENAI_DEFAULT_MODEL } from '../byok/env-openai.js';
import { resolveProviderConfig } from '../media/config.js';

const TEXT_CAP = 12_000;
const FETCH_TIMEOUT_MS = 20_000;

const SYSTEM = `You turn a public web page into a table of records for a company workspace.

Return STRICT JSON and nothing else:
{"table":"snake_case_name","rows":[{"col":"value"}]}

Rules:
- rows is an array of objects that share the same keys
- short column names from the page (name, title, price, date, role, url, …)
- 2 to 80 rows is enough; skip navigation, ads, and legal boilerplate
- keep cell values as strings
- if the page has no factual records, return {"table":"","rows":[]}`;

export interface ImportAiResult {
  rows: string[][];
  tableName?: string;
}

export type ImportAiExtractor = (input: {
  url: string;
  html: string;
  text: string;
}) => Promise<ImportAiResult | null>;

export function pageHtmlToText(html: string): string {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const body = decodeEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const combined = [title, body].filter(Boolean).join('\n\n');
  return combined.slice(0, TEXT_CAP);
}

function decodeEntities(value: string): string {
  return value.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function rowsFromAiJson(raw: string): ImportAiResult | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const rowsUnknown = parsed.rows;
  if (!Array.isArray(rowsUnknown) || rowsUnknown.length === 0) return null;
  const objects = rowsUnknown.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  );
  if (objects.length === 0) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of objects) {
    for (const key of Object.keys(row)) {
      if (!key || seen.has(key)) continue;
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
  const table = typeof parsed.table === 'string' ? parsed.table.trim() : '';
  return {
    rows: [keys, ...objects.map((row) => keys.map((key) => cell(row[key])))],
    ...(table ? { tableName: table.replace(/[^\w]+/g, '_').slice(0, 40) } : {}),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(fences[i]?.[1] ?? '') as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      /* try earlier fence */
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    const value = JSON.parse(text.slice(first, last + 1)) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export async function defaultExtractTabularWithAi(input: {
  url: string;
  html: string;
  text: string;
}): Promise<ImportAiResult | null> {
  const text = input.text.trim();
  if (text.length < 40) return null;
  const creds = await resolveAiCreds();
  if (!creds) return null;
  const user = `URL: ${input.url}\n\nPAGE:\n${text}`;
  let raw: string;
  try {
    raw = await completeJson(creds, SYSTEM, user);
  } catch {
    return null;
  }
  return rowsFromAiJson(raw);
}

async function resolveAiCreds(): Promise<{ apiKey: string; baseUrl: string; model: string } | null> {
  const envKey = readEnvOpenAiApiKey();
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: ENV_OPENAI_DEFAULT_BASE_URL,
      model: ENV_OPENAI_DEFAULT_MODEL,
    };
  }
  const dataDir = process.env.OD_DATA_DIR?.trim();
  if (!dataDir) return null;
  try {
    const cfg = await resolveProviderConfig(dataDir, 'openai');
    if (!cfg.apiKey) return null;
    return {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl || ENV_OPENAI_DEFAULT_BASE_URL,
      model: cfg.model || ENV_OPENAI_DEFAULT_MODEL,
    };
  } catch {
    return null;
  }
}

async function completeJson(
  creds: { apiKey: string; baseUrl: string; model: string },
  system: string,
  user: string,
): Promise<string> {
  const base = creds.baseUrl.replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) || /\/chat\/completions$/.test(base)
    ? (base.endsWith('/chat/completions') ? base : `${base}/chat/completions`)
    : `${base}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({
      model: creds.model,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`ai ${resp.status}`);
  }
  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}
