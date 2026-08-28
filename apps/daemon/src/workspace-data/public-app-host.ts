// Trusted host for a public share of a data-connected app.
//
// The untrusted page still has no network (`connect-src 'none'`) and runs in
// an iframe sandboxed without `allow-same-origin`. This parent page is the
// backend: it listens for `postMessage`, POSTs to `/s/:token/data` without
// cookies, and forwards the reply. Anonymous visitors may only append to
// tables a person marked public-write, and only when the app declared write.

import type Database from 'better-sqlite3';
import {
  APP_BRIDGE_PROTOCOL,
  APP_SDK_SOURCE,
  publicFacingScopes,
  publicScopeAllows,
  type AppBridgeRequest,
  type AppBridgeResponse,
  type AppDataScope,
  type JsonValue,
  type OrgApp,
  type WorkspaceTable,
} from '@open-design/contracts';
import { createRecord } from './records.js';
import { listTables, loadTableByName } from './schema.js';
import type { WorkspaceActor } from './types.js';

type SqliteDb = Database.Database;

const INNER_CSP =
  "default-src 'none'; " +
  'img-src data: blob: https: http:; ' +
  'media-src data: blob: https: http:; ' +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  'font-src data: https: http:; ' +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'";

/** CSP for the trusted wrapper. The iframe's own CSP stays `connect-src none`. */
export const PUBLIC_APP_HOST_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  'img-src data:',
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');

const INGEST_WINDOW_MS = 60_000;
const INGEST_MAX_PER_WINDOW = 30;

const ingestBuckets = new Map<string, { resetAt: number; count: number }>();

export function allowPublicIngest(token: string, now = Date.now()): boolean {
  const bucket = ingestBuckets.get(token);
  if (!bucket || now >= bucket.resetAt) {
    ingestBuckets.set(token, { resetAt: now + INGEST_WINDOW_MS, count: 1 });
    return true;
  }
  if (bucket.count >= INGEST_MAX_PER_WINDOW) return false;
  bucket.count += 1;
  return true;
}

export function publicWriteTableNames(tables: readonly WorkspaceTable[]): Set<string> {
  return new Set(
    tables
      .filter((table) => table.publicWrite === true && table.status === 'active')
      .map((table) => table.name),
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function renderPublicAppHost(input: { appHtml: string; title: string }): string {
  const inner = [
    `<meta http-equiv="Content-Security-Policy" content="${INNER_CSP}">`,
    `<script>${APP_SDK_SOURCE}</script>`,
    input.appHtml,
  ].join('\n');
  const title = escapeHtml(input.title || 'App');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="app" sandbox="allow-scripts" title="${title}"></iframe>
<script>
(function () {
  var frame = document.getElementById('app');
  frame.srcdoc = ${JSON.stringify(inner)};
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var request = event.data;
    if (!request || typeof request.id !== 'string') return;
    fetch('data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'omit'
    }).then(function (res) {
      return res.json().then(function (body) {
        var reply = body && typeof body.ok === 'boolean'
          ? body
          : {
              protocol: request.protocol,
              id: request.id,
              ok: false,
              error: (body && body.error && body.error.message) || res.statusText || 'refused'
            };
        frame.contentWindow.postMessage(reply, '*');
      });
    }).catch(function (err) {
      frame.contentWindow.postMessage({
        protocol: request.protocol,
        id: request.id,
        ok: false,
        error: String((err && err.message) || err)
      }, '*');
    });
  });
})();
</script>
</body>
</html>
`;
}

export function setPublicIngestCors(headers: { setHeader(name: string, value: string): void }): void {
  headers.setHeader('Access-Control-Allow-Origin', '*');
  headers.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.setHeader('Access-Control-Allow-Headers', 'content-type');
  headers.setHeader('Access-Control-Max-Age', '600');
}

function asBridgeRequest(body: unknown): AppBridgeRequest | null {
  if (!body || typeof body !== 'object') return null;
  const request = body as AppBridgeRequest;
  if (typeof request.id !== 'string' || typeof request.kind !== 'string') return null;
  if (request.protocol !== APP_BRIDGE_PROTOCOL) return null;
  return request;
}

function refuse(id: string, error: string): AppBridgeResponse {
  return { protocol: APP_BRIDGE_PROTOCOL, id, ok: false, error };
}

function describeTable(table: WorkspaceTable) {
  return {
    name: table.name,
    displayName: table.displayName,
    fields: table.fields.map((field) => ({
      name: field.name,
      displayName: field.displayName,
      type: field.type,
      required: field.required,
      options: (field.config as { options?: string[] } | null)?.options ?? null,
    })),
  };
}

export function handlePublicAppBridge(
  db: SqliteDb,
  app: OrgApp,
  shareId: string,
  body: unknown,
): { response: AppBridgeResponse; created?: { tableId: string; recordId: string } } {
  const request = asBridgeRequest(body);
  if (!request) {
    return { response: refuse('', 'the request was not a valid app message') };
  }

  const scopes: readonly AppDataScope[] = app.dataScopes ?? [];
  const publicWriteTables = publicWriteTableNames(listTables(db));
  const decision = publicScopeAllows(scopes, publicWriteTables, request);
  if (!decision.allowed) {
    return { response: refuse(request.id, decision.reason ?? 'refused') };
  }

  const actor: WorkspaceActor = { kind: 'public-form', memberId: shareId };

  try {
    switch (request.kind) {
      case 'scopes':
        return {
          response: {
            protocol: APP_BRIDGE_PROTOCOL,
            id: request.id,
            ok: true,
            result: { scopes: publicFacingScopes(scopes, publicWriteTables) },
          },
        };
      case 'describe': {
        const table = loadTableByName(db, request.table);
        return {
          response: {
            protocol: APP_BRIDGE_PROTOCOL,
            id: request.id,
            ok: true,
            result: describeTable(table),
          },
        };
      }
      case 'create': {
        const table = loadTableByName(db, request.table);
        const record = createRecord(db, table, actor, (request.data ?? {}) as Record<string, JsonValue>);
        return {
          response: {
            protocol: APP_BRIDGE_PROTOCOL,
            id: request.id,
            ok: true,
            result: { record },
          },
          created: { tableId: table.id, recordId: record.id },
        };
      }
      default:
        return {
          response: refuse(
            request.id,
            'anonymous visitors may only add rows, not read or change existing ones',
          ),
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { response: refuse(request.id, message) };
  }
}
