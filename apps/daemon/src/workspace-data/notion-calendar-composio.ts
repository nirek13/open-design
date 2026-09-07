// Parse Composio Notion payloads into calendar events (dated pages / database rows).

import type { BoundedJsonObject } from '../live-artifacts/schema.js';
import { composioConnectorProvider } from '../connectors/composio.js';
import type { ConnectorCredentialMaterial } from '../connectors/service.js';

export interface NotionCalendarEventDraft {
  id: string;
  databaseId: string | null;
  databaseName: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}

const NOTION_CONNECTOR_ID = 'notion';

function notionTool(name: string) {
  return {
    name,
    providerToolId: name,
    description: name,
    inputSchema: { type: 'object' },
    safety: { sideEffect: 'read', approval: 'auto', reason: 'notion calendar' },
  } as never;
}

async function executeNotionTool(
  toolName: string,
  input: BoundedJsonObject,
  credentials: ConnectorCredentialMaterial | undefined,
): Promise<unknown> {
  return composioConnectorProvider.execute(
    { id: NOTION_CONNECTOR_ID } as never,
    notionTool(toolName),
    input,
    credentials,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function collectObjects(value: unknown, into: Record<string, unknown>[]): void {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectObjects(item, into);
    return;
  }
  const rec = asRecord(parsed);
  if (!rec) return;
  into.push(rec);
  for (const key of ['results', 'items', 'pages', 'databases', 'data', 'response_data', 'response', 'children']) {
    if (key in rec) collectObjects(rec[key], into);
  }
}

function titleFromRichText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      const rec = asRecord(item);
      if (!rec) return typeof item === 'string' ? item : '';
      return stringField(rec, 'plain_text', 'plainText', 'text') ?? '';
    }).filter(Boolean);
    return parts.join('') || null;
  }
  const rec = asRecord(value);
  if (!rec) return null;
  return titleFromRichText(rec.title) ?? titleFromRichText(rec.rich_text) ?? titleFromRichText(rec.text);
}

function dateFromProperty(value: unknown): { start: string; end: string | null; allDay: boolean } | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return { start: value, end: null, allDay: value.length <= 10 };
    }
    return null;
  }
  const nested = asRecord(rec.date) ?? rec;
  const start = stringField(nested, 'start', 'start_date', 'startDate', 'startsAt');
  if (!start) return null;
  const end = stringField(nested, 'end', 'end_date', 'endDate', 'endsAt');
  return { start, end, allDay: start.length <= 10 && (!end || end.length <= 10) };
}

function propertiesOf(rec: Record<string, unknown>): Record<string, unknown> {
  const props = asRecord(rec.properties) ?? asRecord(rec.props);
  return props ?? rec;
}

function eventTitle(rec: Record<string, unknown>): string {
  const direct = stringField(rec, 'title', 'name', 'Name', 'page_title', 'pageTitle');
  if (direct) return direct;
  const fromTitle = titleFromRichText(rec.title);
  if (fromTitle) return fromTitle;
  const props = propertiesOf(rec);
  for (const [key, value] of Object.entries(props)) {
    const nested = asRecord(value);
    if (nested && (nested.type === 'title' || key.toLowerCase() === 'name' || key.toLowerCase() === 'title')) {
      const text = titleFromRichText(nested) ?? titleFromRichText(nested.title);
      if (text) return text;
    }
  }
  return 'Untitled';
}

function eventDate(rec: Record<string, unknown>): { start: string; end: string | null; allDay: boolean } | null {
  const direct = dateFromProperty(rec.date)
    ?? dateFromProperty({ start: rec.start_date ?? rec.startDate, end: rec.end_date ?? rec.endDate });
  if (direct) return direct;
  const props = propertiesOf(rec);
  for (const value of Object.values(props)) {
    const nested = asRecord(value);
    if (!nested) continue;
    if (nested.type === 'date' || nested.date || nested.start || nested.start_date) {
      const parsed = dateFromProperty(nested) ?? dateFromProperty(nested.date);
      if (parsed) return parsed;
    }
  }
  return null;
}

function locationOf(rec: Record<string, unknown>): string | null {
  const props = propertiesOf(rec);
  for (const [key, value] of Object.entries(props)) {
    if (!/location|place|where/i.test(key)) continue;
    const nested = asRecord(value);
    const text = typeof value === 'string'
      ? value
      : titleFromRichText(nested) ?? stringField(nested ?? {}, 'plain_text', 'name');
    if (text?.trim()) return text.trim();
  }
  return stringField(rec, 'location', 'url');
}

export function extractNotionCalendarEvents(payload: unknown): NotionCalendarEventDraft[] {
  const found: Record<string, unknown>[] = [];
  collectObjects(payload, found);
  const out: NotionCalendarEventDraft[] = [];
  const seen = new Set<string>();
  for (const rec of found) {
    const objectType = stringField(rec, 'object', 'type');
    if (objectType === 'database') continue;
    const date = eventDate(rec);
    if (!date) continue;
    const id = stringField(rec, 'id', 'page_id', 'pageId', 'row_id') ?? `${date.start}-${eventTitle(rec)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = asRecord(rec.parent);
    const databaseId = stringField(rec, 'database_id', 'databaseId')
      ?? (parent ? stringField(parent, 'database_id', 'databaseId', 'id') : null);
    out.push({
      id,
      databaseId,
      databaseName: stringField(rec, 'database_name', 'databaseName', 'parent_title'),
      title: eventTitle(rec),
      description: stringField(rec, 'url', 'description') ?? null,
      location: locationOf(rec),
      startsAt: date.start,
      endsAt: date.end ?? date.start,
      allDay: date.allDay,
    });
  }
  return out;
}

export function extractNotionDatabases(payload: unknown): Array<{ id: string; title: string }> {
  const found: Record<string, unknown>[] = [];
  collectObjects(payload, found);
  const out: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  for (const rec of found) {
    const objectType = stringField(rec, 'object', 'type');
    const id = stringField(rec, 'id', 'database_id', 'databaseId');
    if (!id) continue;
    const looksLikeDb = objectType === 'database'
      || Boolean(asRecord(rec.properties) && !eventDate(rec) && rec.title);
    if (!looksLikeDb && objectType !== 'database') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: eventTitle(rec) || 'Notion database',
    });
  }
  return out;
}

export async function listNotionCalendarEvents(
  credentials: ConnectorCredentialMaterial | undefined,
  options?: { databaseId?: string },
): Promise<NotionCalendarEventDraft[]> {
  if (options?.databaseId) {
    const queried = await queryDatabase(credentials, options.databaseId);
    if (queried.length > 0) return queried;
  }

  const searchPayload = await executeNotionTool(
    'NOTION_SEARCH',
    { query: '', page_size: 100 },
    credentials,
  ).catch(() => executeNotionTool(
    'NOTION_SEARCH_NOTION_PAGE',
    { query: '', page_size: 100 },
    credentials,
  ));

  const fromSearch = extractNotionCalendarEvents(searchPayload);
  const databases = options?.databaseId
    ? [{ id: options.databaseId, title: 'Notion' }]
    : extractNotionDatabases(searchPayload);

  const byId = new Map(fromSearch.map((event) => [event.id, event]));
  for (const database of databases) {
    const rows = await queryDatabase(credentials, database.id);
    for (const row of rows) {
      byId.set(row.id, {
        ...row,
        databaseId: row.databaseId ?? database.id,
        databaseName: row.databaseName ?? database.title,
      });
    }
  }
  return [...byId.values()];
}

async function queryDatabase(
  credentials: ConnectorCredentialMaterial | undefined,
  databaseId: string,
): Promise<NotionCalendarEventDraft[]> {
  const attempts: Array<{ tool: string; input: BoundedJsonObject }> = [
    { tool: 'NOTION_QUERY_DATABASE', input: { database_id: databaseId, page_size: 100 } },
    { tool: 'NOTION_QUERY_DATABASE', input: { databaseId, page_size: 100 } },
    { tool: 'NOTION_FETCH_DATABASE', input: { database_id: databaseId } },
    { tool: 'NOTION_FETCH_ROW', input: { database_id: databaseId } },
  ];
  for (const attempt of attempts) {
    try {
      const payload = await executeNotionTool(attempt.tool, attempt.input, credentials);
      const events = extractNotionCalendarEvents(payload);
      if (events.length > 0) return events;
    } catch {
      // Try the next slug / argument shape.
    }
  }
  return [];
}
