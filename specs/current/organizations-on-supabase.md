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
| `storage/postgres-schema.ts` — schema + ordered migrations | Written, **not yet run against a live database** |
| `storage/postgres-connection.ts` — pool + lazy `pg` import | Written, **not yet run against a live database** |
| `workspace-data/tenancy.ts` — organizations, members, invites | Ported to `SqlExecutor`; engine-neutral |
| `workspace-data/apps.ts` — apps and share links | Ported to `SqlExecutor`; engine-neutral |
| Server startup selects the backend | Done |
| Tables/records data plane (`schema.ts`, `records.ts`, `query.ts`, `audit.ts`) | **Still SQLite-only** |

The organization layer no longer knows which engine it is talking to, and the
whole flow (bootstrap, invite, publish, share, anonymous view) is verified end
to end on SQLite. The Postgres path has **not** been run against a real
Supabase project — no credentials were available — so treat it as unproven
until someone does. What is proven is that nothing regressed locally.

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

1. **Run the migrations against a real Supabase project.** Set
   `OD_SUPABASE_DB_URL` and start the daemon: it will create the
   `open_design` schema and apply every migration. Confirm the append-only
   triggers fire by trying `UPDATE od_audit_events` as the daemon's role.
   Until this happens the Postgres path is unverified.
2. **Port the tables/records data plane.** This is the larger half and needs
   real dialect decisions, not a translation: SQLite's
   `json_extract(data_json, '$.field')` becomes `data_json->>'field'` over
   `JSONB`, and the partial UNIQUE expression indexes that enforce field
   uniqueness need Postgres equivalents. Do not attempt it as a search and
   replace.
3. **Decide what Row Level Security means here.** The daemon connects as one
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
