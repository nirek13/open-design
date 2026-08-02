// Phase 5 / spec §15.6 — `DaemonDb` adapter stub.
//
// Spec §15.6 calls out a Postgres adapter so multi-replica daemons
// can share state behind a load balancer. v1 ships local SQLite via
// better-sqlite3 (already in `apps/daemon/src/db.ts`). The full lift
// is a substantial migration; this module is the substrate slice
// that pins the parameter surface so a follow-up PR can land the
// adapter without re-litigating the env-var contract.
//
// Today's resolver simply records the operator's choice; the
// existing better-sqlite3 path is the only reachable backend.
// `OD_DAEMON_DB=postgres` returns a stub that throws when used so
// a misconfigured operator sees a clear error instead of silently
// dropping writes onto a non-existent backend.

export type DaemonDbKind = 'sqlite' | 'postgres';

export interface DaemonDbConfig {
  kind: DaemonDbKind;
  postgres?: {
    host:     string;
    port:     number;
    database: string;
    user:     string;
    sslMode?: 'disable' | 'require' | 'verify-full';
    /** Full libpq connection string when the operator supplied one. Supabase
     * hands out a single URI rather than discrete fields, so that is the
     * ergonomic path; the discrete fields above stay supported for operators
     * running their own Postgres. */
    connectionString?: string;
  };
}

/** Supabase gives you one connection URI. Accept it under either the
 * Open-Design-specific name or the conventional `DATABASE_URL` so a standard
 * `.env` from the Supabase dashboard works unmodified. */
function supabaseConnectionString(e: Record<string, string | undefined>): string | undefined {
  const candidates = [e.OD_SUPABASE_DB_URL, e.SUPABASE_DB_URL, e.OD_PG_URL, e.DATABASE_URL];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && /^postgres(ql)?:\/\//i.test(value)) return value;
  }
  return undefined;
}

export class DaemonDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonDbConfigError';
  }
}

export function resolveDaemonDbConfig(env?: Record<string, string | undefined>): DaemonDbConfig {
  const e = env ?? process.env;
  const connectionString = supabaseConnectionString(e);
  // A Supabase URL is an unambiguous statement of intent, so it selects
  // Postgres on its own — an operator who pastes their connection string
  // should not also have to remember a second env var.
  const kind = (e.OD_DAEMON_DB ?? (connectionString ? 'postgres' : 'sqlite')).trim().toLowerCase();
  if (kind === 'postgres') {
    if (connectionString) {
      const url = new URL(connectionString);
      return {
        kind: 'postgres',
        postgres: {
          connectionString,
          host: url.hostname,
          port: Number.parseInt(url.port, 10) || 5432,
          database: url.pathname.replace(/^\//, '') || 'postgres',
          user: decodeURIComponent(url.username) || 'postgres',
          // Supabase terminates TLS and rejects plaintext, so anything other
          // than an explicit opt-out stays encrypted.
          sslMode: e.OD_PG_SSL_MODE === 'disable' ? 'disable' : 'require',
        },
      };
    }
    const host = e.OD_PG_HOST ?? '';
    const portStr = e.OD_PG_PORT ?? '5432';
    const database = e.OD_PG_DATABASE ?? '';
    const user = e.OD_PG_USER ?? '';
    const sslMode = e.OD_PG_SSL_MODE === 'disable' || e.OD_PG_SSL_MODE === 'verify-full'
      ? e.OD_PG_SSL_MODE
      : 'require';
    if (!host || !database || !user) {
      throw new DaemonDbConfigError(
        'OD_DAEMON_DB=postgres needs a connection. Either set OD_SUPABASE_DB_URL ' +
        '(or DATABASE_URL) to your Supabase connection string, or set ' +
        'OD_PG_HOST, OD_PG_DATABASE, and OD_PG_USER. OD_PG_PORT defaults to ' +
        '5432; OD_PG_SSL_MODE defaults to "require".',
      );
    }
    return {
      kind: 'postgres',
      postgres: {
        host,
        port:     Number.parseInt(portStr, 10) || 5432,
        database,
        user,
        sslMode,
      },
    };
  }
  if (kind !== 'sqlite' && kind !== '') {
    throw new DaemonDbConfigError(
      `unknown OD_DAEMON_DB value '${kind}'. Accepted: 'sqlite' (default), 'postgres'.`,
    );
  }
  return { kind: 'sqlite' };
}
