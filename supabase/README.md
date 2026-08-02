# Hosting cloud (Supabase + Clerk)

Backing services for one-click hosting. Design and rationale:
[`specs/current/one-click-hosting.md`](../specs/current/one-click-hosting.md).

## Credential boundary

There is exactly one secret in this system, and it lives in exactly one place.

| Value | Secret? | Lives in |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase edge-function secrets only |
| Supabase anon / publishable key | no | daemon + client; RLS denies every write on its own |
| Supabase project URL | no | daemon + client |
| Clerk publishable key | no | client |
| Clerk **secret** key | **yes** | **not used by hosting at all** |

Hosting verifies Clerk tokens against the issuer's public JWKS, so the Clerk
secret key is never needed here. If one is ever added to a hosting config, that
is a mistake — remove it rather than scoping it.

The daemon must never hold the service-role key. It authenticates to the edge
functions with the caller's own Clerk token and receives per-object signed
upload URLs; that asymmetry is the whole security model, not an inconvenience
to work around.

## Configuration

### Daemon (non-secret)

```sh
OD_HOSTING_SUPABASE_URL=https://vcyqolpofjczcevmslxw.supabase.co
OD_HOSTING_FUNCTIONS_URL=https://vcyqolpofjczcevmslxw.functions.supabase.co
OD_HOSTING_ANON_KEY=sb_publishable_Or_YUDXWKPYpk7jMM1MW-A_T4GjebBT
OD_SITES_DOMAIN=<apex domain that site subdomains hang off>

# Enables clerk identity mode, which org-restricted publishing requires.
OD_CLERK_ISSUER=https://clean-jay-54.clerk.accounts.dev
OD_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlYW4tamF5LTU0LmNsZXJrLmFjY291bnRzLmRldiQ
```

Put these in `.env.local` (already gitignored) or the process environment.

### Edge functions (server-side only)

Set through the Supabase CLI so they never touch the repository:

```sh
supabase secrets set \
  CLERK_ISSUER=https://clean-jay-54.clerk.accounts.dev \
  OD_SITES_DOMAIN=<apex domain> \
  OD_FRAME_ANCESTORS=<product origin, optional>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.

### Clerk ↔ Supabase

Enable Clerk as a **third-party auth provider** on the Supabase project. Every
RLS policy reads `auth.jwt() ->> 'sub'`; without that integration an
authenticated request resolves to a null subject and legitimately sees nothing.

`supabase/config.toml` reads the Clerk domain from `CLERK_DOMAIN` rather than
hardcoding it, so local, staging, and production projects cannot silently share
an issuer.

## Deploy

```sh
supabase link --project-ref vcyqolpofjczcevmslxw
supabase db push
supabase functions deploy serve publish-begin publish-commit sites-manage
```

Then point a **wildcard DNS record** for `*.<sites domain>` at the `serve`
function. `serve` reads the site slug from the first label of the `Host` header
and falls back to a `__od_slug` query parameter for local development.

## Functions

| Function | Auth | Role |
|---|---|---|
| `publish-begin` | Clerk bearer | Claim slug, diff blobs, return signed upload URLs |
| `publish-commit` | Clerk bearer | Verify uploads landed, commit version, advance live pointer |
| `sites-manage` | Clerk bearer (except `/report`) | List, rename, visibility, rollback, unpublish, abuse report |
| `serve` | none (checks visibility itself) | Public request path |

Functions import the hosting core directly from `packages/hosting/src/*.ts`, so
slug rules, the manifest format, and path resolution are byte-identical to what
the daemon runs. Do not fork that logic per runtime.
