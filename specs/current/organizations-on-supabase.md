# Organizations on Supabase

## Why

An organization only means something if the people in it can be in different
places. A SQLite file on one laptop cannot be shared, so the organization
layer — organizations, members, invites, apps, share links — needs a backend
that outlives any one machine. Supabase Postgres is that backend.

Local SQLite stays as the offline default. The packaged desktop app, the
zero-config dev loop, sandbox mode, and every existing test keep working with
no configuration; Postgres is opt-in and additive.

## Status

| Piece | State |
|---|---|
| `storage/sql.ts` — async `SqlExecutor` over SQLite and Postgres | Done, unit-tested |
| `storage/daemon-db.ts` — Supabase connection resolution | Done, unit-tested |
| `storage/postgres-schema.ts` — schema + ordered migrations | Applied to a live Supabase project; re-runs are no-ops |
| `storage/postgres-connection.ts` — pool + lazy `pg` import | Verified against live Supabase |
| `workspace-data/tenancy.ts` — organizations, members, invites | Ported to `SqlExecutor`; engine-neutral |
| `workspace-data/apps.ts` — apps and share links | Ported to `SqlExecutor`; engine-neutral |
| Server startup selects the backend | Done |
| Tables/records data plane (`schema.ts`, `records.ts`, `query.ts`, `audit.ts`) | **Still SQLite-only** |

The organization layer no longer knows which engine it is talking to. The
whole flow — bootstrap, invite, join, publish, share, anonymous view, revoke —
is verified end to end on **both** engines, including a daemon booted against
a real Supabase project with no local organization database on disk.

Two bugs only the live database found, both fixed and covered by tests:

- `od_app_shares` was missing `workspace_id` in the Postgres schema (added as
  migration `0004`, because a shipped migration is never edited).
- `SET search_path` was issued once after connecting. A pool hands out a
  different connection per query, so the setting vanished on rotation and
  unqualified table names started reporting "does not exist" mid-session. It
  is now a startup parameter on the pool, which covers every connection the
  pool ever opens.

## Configuration

Paste the connection string from the Supabase dashboard:

```
OD_SUPABASE_DB_URL=postgresql://…@db.<ref>.supabase.co:5432/postgres
```

`DATABASE_URL`, `SUPABASE_DB_URL`, and `OD_PG_URL` are accepted under the same
rule. A Postgres URL selects the Postgres backend on its own — setting
`OD_DAEMON_DB=postgres` as well is allowed but unnecessary. Operators running
their own Postgres can instead set `OD_PG_HOST` / `OD_PG_DATABASE` /
`OD_PG_USER` (+ `OD_PG_PASSWORD`).

TLS is on unless `OD_PG_SSL_MODE=disable`. `verify-full` enforces the
certificate chain; the default `require` does not, because Supabase's pooler
presents a chain Node has no root for.

All tables live in an `open_design` schema so they cannot collide with
anything else in the operator's Supabase project.

## Remaining work

1. **Port the tables/records data plane.** This is the larger half and needs
   real dialect decisions, not a translation: SQLite's
   `json_extract(data_json, '$.field')` becomes `data_json->>'field'` over
   `JSONB`, and the partial UNIQUE expression indexes that enforce field
   uniqueness need Postgres equivalents. Do not attempt it as a search and
   replace.
2. **Decide what Row Level Security means here.** The daemon connects as one
   role and enforces membership in application code. If Supabase clients are
   ever pointed at these tables directly, RLS policies become mandatory —
   design them before that happens, not after.

## Relationship to one-click hosting

`specs/current/one-click-hosting.md` has an overlapping cloud-only mandate for
published sites. That workstream owns site hosting, slugs, and storage; this
one owns the organization layer's system of record. They should converge on
one Supabase project and one connection helper rather than two — whoever lands
second should adopt the other's `storage/` module instead of adding a parallel
one.
