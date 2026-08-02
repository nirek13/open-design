# One-Click Hosting (Publish to the Web)

## Purpose

Let someone who has built something in Open Design put it on the public web in
one click — no account setup, no API token, no provider choice. The interaction
Lovable ships as "Publish".

The deployed link must satisfy three constraints:

1. **Anyone** can open it in a browser and see the app, with no Open Design
   install.
2. If the visitor **does** have the Open Design app, the link can open there
   instead, so they can keep building on it.
3. The publisher chooses whether a site is **restricted to their organization**
   or **public to the whole web**.

## Cloud-only mandate

Nothing in the hosted path may depend on local compute. Concretely:

- **No daemon in the request path.** A visitor's request never touches the
  publisher's machine.
- **No local SQLite as source of truth.** Sites, versions, and slugs live in
  Supabase Postgres. The daemon may cache, never author.
- **No local credentials with broad scope.** The machine gets scoped, expiring
  upload URLs and nothing else.
- **The link outlives the machine.** Closing the laptop, changing networks, or
  uninstalling the app must not affect a published site.

The daemon's only remaining role is **publisher client**: read local project
files, hash them, upload the bytes. That job cannot move to the cloud because
the source files are on the user's disk — but it ends the moment the upload
commits.

| Concern | Provider |
|---|---|
| Identity, organizations, membership, roles | **Clerk** |
| Sites, versions, slugs, audit, abuse reports | **Supabase Postgres** |
| Static blobs | **Supabase Storage** |
| Publish broker, serving, management API | **Supabase Edge Functions** |

## Scope boundary

This is a **new capability**, not a refactor of the existing deploy feature.
Both coexist:

| | Existing `deploy.ts` | This document |
|---|---|---|
| Trigger | Paste a Vercel or Cloudflare token, pick a provider | One click |
| Hosting | The user's own cloud account | Open Design's Supabase project |
| Ownership | The user's cloud bill | Open Design's cloud bill |

Someone who wants their site on their own infrastructure and their own bill is
well served by the existing path. Leave it alone.

## What already exists and gets reused

- **[deploy.ts:buildDeployFileSet](../../apps/daemon/src/deploy.ts)** already
  walks a project, resolves an entry HTML file, collects referenced assets, and
  reports `missing` / `invalid`. That is the bundler, it is provider-agnostic,
  and it gets reused verbatim.
- **[deploy.ts](../../apps/daemon/src/deploy.ts)** already imports `blake3-wasm`,
  so content hashing needs no new dependency.
- **[identity.ts](../../apps/daemon/src/auth/identity.ts)** already models
  `local-owner` vs `clerk` modes and produces a single `Viewer`.
- **[jwt-verify.ts](../../apps/daemon/src/auth/jwt-verify.ts)** already verifies
  Clerk tokens against JWKS, pinned to RS256, deny-by-default.

## Why `/s/:token` is not the answer

[organizations.ts:371](../../apps/daemon/src/routes/organizations.ts#L371) serves
a published app to anonymous visitors — but **from the daemon on the publisher's
machine**. Close the laptop and the link dies. That is the exact dependency the
cloud-only mandate removes.

It also explains a security upgrade. `/s/:token` is served with
`connect-src 'none'` ([server.ts:2406](../../apps/daemon/src/server.ts#L2406))
because it shares an origin with the daemon's API — the lockdown is what stops a
shared page becoming a hole into organization data. A site served from Supabase
has no daemon adjacent to it, so it can safely be granted `connect-src 'self'`
and be a *more* capable app than a `/s/` share.

## Architecture

```
┌── publisher's machine (publish-time only) ──────────────────┐
│  apps/web      Publish button, status, link, rollback       │
│  apps/daemon   bundle → hash → begin → PUT blobs → commit   │
└───────┬─────────────────────────────────────────────────────┘
        │  Clerk session JWT on every call
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Supabase Edge Functions                                     │
│   publish-begin   auth, slug, ownership, blob diff, sign    │
│   publish-commit  write manifest, advance live pointer      │
│   sites-manage    rename, visibility, rollback, unpublish   │
│   serve           <slug> → visibility gate → blob → HTML    │
└───────┬──────────────────────────────┬──────────────────────┘
        │                              │
        ▼                              ▼
┌────────────────────┐      ┌──────────────────────────────┐
│ Supabase Postgres  │      │ Supabase Storage             │
│ sites, versions,   │      │ content-addressed blobs      │
│ blobs, abuse; RLS  │      │ (private bucket, signed I/O) │
│ keyed on Clerk sub │      └──────────────────────────────┘
└────────────────────┘
```

### Storage layout

```
sites/<site_id>/blobs/<blake3>     immutable, never overwritten
```

Manifests live in Postgres (`site_versions.manifest`, JSONB), not in Storage.
Postgres gives transactional commits and lets the serving function resolve a
path with one indexed query instead of fetching and parsing a JSON object.

Content addressing buys three things at once:

- **Re-publishing is nearly free.** Change one line of HTML and one blob
  uploads. The tenth deploy of a site with a 4 MB image uploads no image.
- **Rollback is a pointer write.** `sites.live_version_id` is the only mutable
  field; no bytes move.
- **Versions are immutable.** A manifest cannot change under a live link.

### Why the daemon never holds Supabase credentials

The daemon runs on the user's machine. Anything it holds, the user holds. A
service-role key there would let any user rewrite any site. So:

- The daemon authenticates to Edge Functions with the **Clerk session JWT it
  already has**.
- `publish-begin` returns **one signed upload URL per missing blob**, each bound
  to a single object key with a short TTL.
- The **service-role key exists only inside Edge Functions**, server-side.

This is also why blob keys are content hashes: a signed URL for
`blobs/<hash>` can only write bytes that hash to that name, so a stolen URL
cannot substitute different content.

### Clerk ↔ Supabase integration

Clerk is registered as a **third-party auth provider** on the Supabase project.
Supabase then accepts Clerk session JWTs directly, and RLS policies read:

- `auth.jwt() ->> 'sub'` — the Clerk user id
- `auth.jwt() -> 'o' ->> 'id'` — the active Clerk organization id
- `auth.jwt() -> 'o' ->> 'rol'` — the role in that organization

Membership is therefore **never mirrored into Postgres**. Clerk stays the single
source of truth, revocation is immediate, and there is no sync job to go stale.
This is the pivotal simplification the Supabase move buys: the previous design
needed a membership snapshot at the edge and had a revocation-lag problem.

## Visibility

| Tier | Who can open it | Enforcement |
|---|---|---|
| `public` | Anyone on the web | None |
| `org` | Signed-in members of the owning Clerk org | `serve` verifies the Clerk JWT and compares the `o.id` claim to `sites.org_id` |

**An org-restricted site requires Clerk mode.** In `local-owner` mode the daemon
refuses an `org` publish and explains why. Root `AGENTS.md` already states that
local-owner is not a security boundary — anyone who can reach the daemon port is
the owner — so accepting an "org-restricted" publish there would promise access
control that does not exist. Public publishing works in both modes.

An anonymous request for an `org` site returns **404, not 403**: a 403 confirms
the slug exists, which leaks the existence of internal tools.

## The "open in the app" handoff

**The canonical link is always `https://<slug>.<sites-domain>`.** A custom-scheme
URL as the shareable link is dead for most recipients and looks broken rather
than degraded.

**A browser cannot reliably detect an installed app.** There is no honest API.
The workable pattern is try-and-observe:

1. The page renders immediately. The web view never blocks on a deep link.
2. An "Open in Open Design" affordance attempts
   `opendesign://open?slug=<slug>&v=<version>`.
3. A ~1.2s timer races `visibilitychange` / `pagehide`. If the document hides,
   the app took over. If the timer wins, the app is absent — keep the page.
4. The choice persists in `localStorage`; a returning visitor who opted in gets
   the attempt automatically.

**A first-time anonymous visitor is never auto-redirected.** Hijacking a
stranger's click into a scheme prompt for software they do not have is hostile.

### This needs new OS-level protocol registration

`od://` is **already taken, and not by a deep link** — it is an internal Electron
privileged scheme registered in [protocol.ts](../../apps/packaged/src/protocol.ts)
to serve the packaged renderer at `od://app/`. Nothing calls
`setAsDefaultProtocolClient`, so there is **no OS-registered deep link today**.

New work: register a distinct `opendesign://` scheme; handle macOS `open-url`
and Windows/Linux `second-instance` argv; own it in `apps/packaged` per root
`AGENTS.md`, with a dev equivalent in `apps/desktop`. Deep-link payloads are
**untrusted input from a web page** — parse strictly, allowlist route shapes,
never trigger a write or publish without in-app confirmation.

*Future upgrade:* Universal Links / App Links remove the timer heuristic
entirely, at the cost of a domain association file and a signed app.

## Database schema

Postgres, in Supabase. RLS on every table, keyed on Clerk claims.

```sql
create table sites (
  id               uuid primary key default gen_random_uuid(),
  slug             citext not null unique,
  owner_user_id    text not null,          -- Clerk sub
  org_id           text,                   -- Clerk org id; null = personal
  visibility       text not null default 'public' check (visibility in ('public','org')),
  live_version_id  uuid,
  status           text not null default 'active' check (status in ('active','unpublished','suspended')),
  project_id       text,                   -- provenance only
  entry_file       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table site_versions (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites(id) on delete cascade,
  version_number integer not null,
  manifest       jsonb not null,           -- { "index.html": {hash,size,contentType}, ... }
  file_count     integer not null,
  total_bytes    bigint not null,
  created_by     text not null,
  created_at     timestamptz not null default now(),
  unique (site_id, version_number)
);

create table site_blobs (
  site_id    uuid not null references sites(id) on delete cascade,
  hash       text not null,
  size       bigint not null,
  created_at timestamptz not null default now(),
  primary key (site_id, hash)
);

create table abuse_reports (...);
```

`site_blobs` is what makes the incremental upload diff a single indexed query
instead of a Storage listing.

## Surfaces

Root `AGENTS.md` requires every capability on **both** the web UI and the `od`
CLI in the same PR, against the same endpoints.

### Daemon HTTP (thin proxy over Edge Functions)

```
POST   /api/projects/:id/publish       { fileName, slug?, visibility? } -> 202
GET    /api/projects/:id/sites
GET    /api/sites/:siteId
GET    /api/sites/:siteId/versions
PATCH  /api/sites/:siteId              { slug?, visibility? }
POST   /api/sites/:siteId/rollback     { versionId }
POST   /api/sites/:siteId/unpublish
GET    /api/sites/slug-available?slug=
```

The daemon keeps these routes rather than having the web app call Supabase
directly, because **only the daemon can read project files**. Publish is
asynchronous with SSE progress; the rest proxy through.

### Web UI

A **Publish** button in the project/file view. First publish: slug suggestion,
public/organization toggle, confirm. Afterwards: live link with copy,
Republish, version history with rollback, unpublish. New i18n keys land in
`types.ts` first, then all 19 locales.

### CLI

Named `od publish`, not `od deploy` — `deploy` already means BYO-provider and
overloading it would make both harder to explain.

```
od publish --project <id> --file index.html [--slug my-app] [--public|--org] [--json]
od publish list     --project <id> [--json]
od publish status   <siteId> [--json]
od publish rollback <siteId> --version <n>
od publish unpublish <siteId>
```

## Security

- **No service-role key outside Edge Functions.** The daemon holds only its
  Clerk session token and short-lived signed upload URLs.
- **Signed upload URLs are per-blob, content-addressed, short-TTL.** A stolen
  URL cannot write content that does not hash to its key.
- **RLS on every table**, keyed on Clerk claims, deny-by-default. The public
  read path goes through the `serve` function, not through a permissive policy.
- **Slug ownership is authoritative in Postgres.** Reserved-name list for
  `www`, `api`, `admin`, `app`, `mail`, `static`, `assets`, and product
  hostnames.
- **Size and rate caps** reuse the constants already tuned in `deploy.ts` —
  25 MB per asset, 100 files, 75 MB per batch — plus publishes-per-hour.
- **Org sites 404 for non-members**, never 403.
- **Deep-link payloads are untrusted.** Strict parsing, allowlisted routes.
- **Host user content on a separate registrable domain** from the product —
  product on `opendesign.app`, user sites on something like `od-sites.dev`.
  This is the most important item here and the most expensive to reverse.
  Arbitrary user HTML on a product subdomain means a phishing page appears
  Open-Design-hosted, and puts attacker script within reach of domain-scoped
  cookie and `postMessage` trust. Lovable does exactly this split. Decide it
  before the first public link is issued.
- **Takedown path from day one:** abuse report route, an operator action that
  suspends a slug, and a record of what was served.

## Rollout

| Phase | Contents |
|---|---|
| 0 | Decide the sites domain, the Supabase project owner, the spend ceiling. Blocks everything. |
| 1 | Schema + RLS, `publish-begin` / `publish-commit` / `serve`, daemon client and routes, Publish button, `od publish`. Public sites only. |
| 2 | Version history, rollback, incremental blob diff. |
| 3 | Org-gated sites via the Clerk org claim. |
| 4 | `opendesign://` registration and the try-and-observe handoff. |
| 5 | Custom domains, Universal Links, analytics. |

Phase 1 alone delivers one-click "put it on the web". Phase 4 is last because
the HTTPS link is already correct without it.

## Testing

- **`packages/hosting`** — unit tests on manifest hashing, slug normalization,
  path resolution. Pure functions, so edge cases get pinned cheaply here.
- **Daemon** — Vitest at the HTTP boundary with Edge Functions faked: publish
  advances status, an `org` publish in local-owner mode is refused, slug
  collisions surface cleanly.
- **Edge Functions** — Deno tests for visibility (anonymous request to an `org`
  site must 404 with no body leak), path resolution parity with
  `packages/hosting`, cache headers.
- **RLS** — direct SQL tests asserting a user cannot read or write another
  user's site rows. RLS bugs are silent and total; they need explicit coverage.
- **e2e** — publish → fetch public URL → republish → assert new content →
  rollback → assert old content.
- **Manual** — the deep-link handoff needs a human per OS.

## Open decisions

1. **Sites domain.** What is the separate user-content domain? (Expensive to
   reverse — see security.)
2. **Supabase project owner** and spend ceiling.
3. **Free-tier limits.** Sites per user, total bytes, bandwidth.
4. **Anonymous publishing.** In `local-owner` mode there is no Clerk identity.
   Does public publish require signing in, or does the daemon get a
   device-scoped token? *Assumed for now: publishing requires Clerk sign-in;
   local-owner can browse but not publish.*
5. **Retention.** How long do superseded blobs live before garbage collection?
