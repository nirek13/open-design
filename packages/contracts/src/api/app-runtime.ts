// Apps that can read and write organization data.
//
// The obvious way to build this is to give the app a scoped token and relax
// its CSP so it can call `/api/*` itself. This does not do that, and the
// reason is worth writing down.
//
// A published app is untrusted code — a customer wrote it, or a model did.
// Relaxing `connect-src` gives that code a network. Even restricted to
// `'self'`, a bug or a hostile author now has an authenticated channel, and
// the token sitting in the page is exfiltratable the moment any external
// origin becomes reachable. The anonymous `/s/:token` path shares the same
// serving code, so a mistake there leaks organization data to the internet.
//
// So instead: the app keeps `connect-src 'none'` and gets **no network at
// all**. It runs in an iframe sandboxed without `allow-same-origin`, so it has
// an opaque origin, no cookies, and no access to the host page. It asks for
// data by `postMessage`. When a member is running the app, the host is already
// authenticated as that person. On a public share link the host is a trusted
// wrapper page that may only append to tables marked public-write.
//
// Three consequences, all good:
//
//   1. An app cannot exfiltrate. It has no way to reach any origin, so data it
//      is given cannot leave the page it was drawn in.
//   2. An app cannot exceed the person running it. The host calls the ordinary
//      `/api/data/*` endpoints with that member's own session, so every
//      tenancy and role check already in the daemon applies unchanged. There
//      is no new privileged path to get wrong.
//   3. Permission is legible. An app declares the tables it needs up front,
//      the person sees that list before running it, and `scopeAllows` below is
//      the single place that decision is enforced.

/** Reserved scope table that grants Gmail through the host bridge, not a
 * workspace table. An app that declares `{ table: 'gmail', mode: 'write' }`
 * may call `od.mail.send`; it still cannot reach Gmail on its own. */
export const APP_GMAIL_SCOPE_TABLE = 'gmail';

/** What an app asked for, and whether it may write. `read` is not implied by
 * `write`: an app that only appends should not be able to enumerate. */
export interface AppDataScope {
  /** Machine name of a workspace table, or `gmail` for sending mail. */
  table: string;
  mode: 'read' | 'write';
}

/** Bumped when the message shape changes. The host refuses a mismatch rather
 * than guessing, because a half-understood request is worse than no data. */
export const APP_BRIDGE_PROTOCOL = 1 as const;

export type AppBridgeRequest =
  | { protocol: number; id: string; kind: 'describe'; table: string }
  | {
      protocol: number;
      id: string;
      kind: 'query';
      table: string;
      filters?: Array<{ field: string; op: string; value?: unknown }>;
      sort?: { field: string; direction: 'asc' | 'desc' };
      limit?: number;
    }
  | { protocol: number; id: string; kind: 'create'; table: string; data: Record<string, unknown> }
  | {
      protocol: number;
      id: string;
      kind: 'update';
      table: string;
      recordId: string;
      data: Record<string, unknown>;
    }
  /** Which tables this app may touch — so an app can adapt rather than
   * guessing and being refused. */
  | { protocol: number; id: string; kind: 'scopes' }
  /** Send Gmail as the connected org account. Needs a `gmail` write scope. */
  | {
      protocol: number;
      id: string;
      kind: 'mail.send';
      to: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      subject: string;
      body: string;
      isHtml?: boolean;
    };

export type AppBridgeResponse =
  | { protocol: number; id: string; ok: true; result: unknown }
  | { protocol: number; id: string; ok: false; error: string };

/** Requests that only read. Everything else needs a `write` scope. */
const READ_KINDS = new Set(['describe', 'query', 'scopes']);

export interface ScopeDecision {
  allowed: boolean;
  /** Why not, phrased for the app author reading a console message. */
  reason?: string;
}

/** The one place an app's request is checked against what it declared.
 *
 * Deny by default: an unrecognised request kind, a missing table, or a scope
 * list that does not name the table is refused. A new request kind added to
 * the union without being added here is therefore refused rather than silently
 * permitted, which is the failure direction to prefer. */
export function scopeAllows(
  scopes: readonly AppDataScope[],
  request: { kind: string; table?: string },
): ScopeDecision {
  if (request.kind === 'scopes') return { allowed: true };

  if (request.kind === 'mail.send') {
    return scopes.some((scope) => scope.table === APP_GMAIL_SCOPE_TABLE && scope.mode === 'write')
      ? { allowed: true }
      : {
          allowed: false,
          reason: "this app did not ask to send Gmail when it was published",
        };
  }

  const known = READ_KINDS.has(request.kind) || request.kind === 'create' || request.kind === 'update';
  if (!known) {
    return { allowed: false, reason: `'${request.kind}' is not a request this host understands` };
  }

  const table = typeof request.table === 'string' ? request.table.trim() : '';
  if (!table) return { allowed: false, reason: 'the request did not name a table' };

  const forTable = scopes.filter((scope) => scope.table === table);
  if (forTable.length === 0) {
    return {
      allowed: false,
      reason: `this app did not ask for access to '${table}' when it was published`,
    };
  }

  if (READ_KINDS.has(request.kind)) {
    // A write scope implies being able to read the table it writes to;
    // otherwise an app could not check what it just wrote.
    return forTable.some((scope) => scope.mode === 'read' || scope.mode === 'write')
      ? { allowed: true }
      : { allowed: false, reason: `this app may not read '${table}'` };
  }

  return forTable.some((scope) => scope.mode === 'write')
    ? { allowed: true }
    : { allowed: false, reason: `this app may only read '${table}', not change it` };
}

const HTML_TABLE_CALL =
  /\b(?:window\s*\.\s*)?(?:od|api)\s*\.\s*(query|describe|create|update)\s*\(\s*(['"`])([^'"`]+)\2/g;

const HTML_MAIL_CALL = /\b(?:window\s*\.\s*)?(?:od|api)\s*\.\s*mail\s*\.\s*send\b/;

/** Tables an HTML app actually talks to, inferred from `od.*` / `api.*` calls.
 *
 * Used to *propose* scopes at publish time — never to grant them. Write is
 * only inferred from `create` / `update`; `query` / `describe` stay read.
 * A write on a table replaces a read for the same name. */
export function inferAppScopesFromHtml(source: string | null | undefined): AppDataScope[] {
  if (!source) return [];
  const modes = new Map<string, 'read' | 'write'>();
  HTML_TABLE_CALL.lastIndex = 0;
  for (const match of source.matchAll(HTML_TABLE_CALL)) {
    const method = match[1];
    const table = match[3]?.trim() ?? '';
    if (!table || table === APP_GMAIL_SCOPE_TABLE) continue;
    const mode = method === 'create' || method === 'update' ? 'write' : 'read';
    if (modes.get(table) === 'write') continue;
    modes.set(table, mode);
  }
  const out: AppDataScope[] = [...modes.entries()].map(([table, mode]) => ({ table, mode }));
  HTML_MAIL_CALL.lastIndex = 0;
  if (HTML_MAIL_CALL.test(source)) {
    out.push({ table: APP_GMAIL_SCOPE_TABLE, mode: 'write' });
  }
  return normalizeAppScopes(out);
}

/** Normalize and bound a declared scope list. Rejects nothing — a malformed
 * entry is dropped rather than throwing, because a publish should not fail on
 * a stray value, and dropping is the safe direction. */
export function normalizeAppScopes(input: unknown): AppDataScope[] {
  if (!Array.isArray(input)) return [];
  const out: AppDataScope[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const table = typeof (entry as AppDataScope)?.table === 'string'
      ? (entry as AppDataScope).table.trim()
      : '';
    const mode = (entry as AppDataScope)?.mode;
    if (!table || (mode !== 'read' && mode !== 'write')) continue;
    const key = `${table}:${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table, mode });
    if (out.length >= 64) break;
  }
  return out;
}

/** A one-line description of what an app can do, for the confirm step before
 * someone runs it. */
export function describeAppScopes(scopes: readonly AppDataScope[]): string {
  if (scopes.length === 0) return 'This app does not read or change any of your data.';
  const canSendMail = scopes.some((scope) => scope.table === APP_GMAIL_SCOPE_TABLE && scope.mode === 'write');
  const tables = scopes.filter((scope) => scope.table !== APP_GMAIL_SCOPE_TABLE);
  const writes = [...new Set(tables.filter((s) => s.mode === 'write').map((s) => s.table))];
  const reads = [...new Set(tables.filter((s) => s.mode === 'read').map((s) => s.table))].filter(
    (table) => !writes.includes(table),
  );
  const parts: string[] = [];
  if (reads.length) parts.push(`read ${reads.join(', ')}`);
  if (writes.length) parts.push(`read and change ${writes.join(', ')}`);
  if (canSendMail) parts.push('send Gmail from the connected account');
  if (parts.length === 0) return 'This app does not read or change any of your data.';
  return `This app can ${parts.join('; ')}.`;
}

/** True when the app asked to write workspace tables (not Gmail). Those apps
 * get a host-side backend on a public share link so the untrusted page still
 * has no network of its own. */
export function appRequestsTableWrites(scopes: readonly AppDataScope[]): boolean {
  return scopes.some((scope) => scope.table !== APP_GMAIL_SCOPE_TABLE && scope.mode === 'write');
}

/** Anonymous visitors on a share link. They may only append to tables that
 * both the app declared write access to and a person marked as public-write.
 * Query, update, and mail are refused even if the app itself could do them
 * when run by a member. */
export function publicScopeAllows(
  scopes: readonly AppDataScope[],
  publicWriteTables: ReadonlySet<string>,
  request: { kind: string; table?: string },
): ScopeDecision {
  if (request.kind === 'scopes') return { allowed: true };

  if (request.kind === 'query' || request.kind === 'update' || request.kind === 'mail.send') {
    return {
      allowed: false,
      reason: 'anonymous visitors may only add rows, not read or change existing ones',
    };
  }

  const gated = scopeAllows(scopes, request);
  if (!gated.allowed) return gated;

  const table = typeof request.table === 'string' ? request.table.trim() : '';
  if (!table) return { allowed: false, reason: 'the request did not name a table' };
  if (!publicWriteTables.has(table)) {
    return {
      allowed: false,
      reason: `table '${table}' does not allow public submissions`,
    };
  }
  return { allowed: true };
}

/** The scopes a public visitor may actually use: write grants on tables that
 * a person marked as accepting public forms. Gmail is never public. */
export function publicFacingScopes(
  scopes: readonly AppDataScope[],
  publicWriteTables: ReadonlySet<string>,
): AppDataScope[] {
  return scopes.filter(
    (scope) =>
      scope.table !== APP_GMAIL_SCOPE_TABLE &&
      scope.mode === 'write' &&
      publicWriteTables.has(scope.table),
  );
}

