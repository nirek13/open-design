# The business layer

## Why it is shaped this way

Two things have to be true at once, and they pull in opposite directions.

Anyone should be able to change the system by asking — "add a PO number to
orders" ought to take seconds, not a migration. And the books have to be
correct, because an accounting system that can be talked into an inconsistent
state is worse than no accounting system.

The resolution is a hard line down the middle:

- **Business documents are soft.** Customers, quotes, orders, invoices, and
  payments are ordinary workspace tables. Their schemas grow on request.
- **The ledger is rigid.** Journal entries and lines are first-class tables
  with database-level immutability. Nothing bends them.

They meet at a small, explicit contract: a handful of fields carry a **role**
(`total`, `customer-link`, `status`, `issue-date`, …) that automatic
accounting reads. Someone can add ten columns of their own to invoices and
posting keeps working, because posting looks for roles, not positions.

## What is built

| Capability | Where |
|---|---|
| Business hub seed + document numbering + quote→order→invoice→bill | `workspace-data/hub.ts` |
| Template packs: registry, dependency order, idempotent install | `workspace-data/templates.ts`, `contracts/api/erp-templates.ts` |
| Deal pipeline: stages, weighted forecast, deal→quote | `workspace-data/crm.ts` |
| Payables: outstanding and overdue, derived from payments | `workspace-data/payables.ts` |
| Stock on hand, summed from movements | `workspace-data/inventory.ts` |
| Project hours, billable value, budget | `workspace-data/projects.ts` |
| Team chat: channels, threads, unread | `workspace-data/chat.ts`, `routes/team-chat.ts` |
| Notion-shaped pages + blocks (notes, table embeds, agent tools) | `workspace-data/pages.ts`, `routes/pages.ts`, `specs/current/notion-pages.md` |
| Plain-English changes: parse, preview, apply | `workspace-data/intent.ts`, `contracts/api/workspace-intent.ts` |
| Saved views: filters, sorts, grouping, board/calendar | `workspace-data/views.ts`, `contracts/api/workspace-views.ts` |
| Formula and rollup fields, evaluated at read time | `workspace-data/formula.ts` |
| Record pages: links, related lists, rollups, valid actions | `workspace-data/related.ts` |
| Version history and restore-to-version | `workspace-data/versions.ts` |
| Rename / retype / remove a field, with impact shown first | `workspace-data/schema-changes.ts` |
| Packs an organization wrote itself, validated then installed | `workspace-data/packs.ts` |
| App runtime: sandboxed apps that read and write org data | `contracts/api/app-runtime.ts`, `web/components/apps/` |
| Double-entry ledger, trial balance, period close | `workspace-data/ledger.ts` |
| Proposals: preview, approve, reject, undo | `workspace-data/proposals.ts` |
| Saved questions and home-screen widgets | `workspace-data/questions.ts` |
| Spreadsheet import: infer, preview, commit | `workspace-data/import.ts` |
| HTTP + agent surface | `routes/erp.ts` |

## The rules the ledger enforces

These are enforced in code *and* by SQLite triggers, so a future refactor
cannot quietly downgrade a guarantee to a convention:

1. **Entries balance.** Debits equal credits, per currency, checked before
   anything is written. An unbalanced entry cannot be posted.
2. **Posted entries are immutable.** No edit, no delete — the triggers refuse
   both. A mistake is corrected by a reversing entry, and the two link to each
   other so the correction is legible.
3. **Closed periods stay closed.** Nothing posts into a closed period, which
   is what makes a reported figure final.
4. **Money is integer minor units.** A float amount is rejected at the
   boundary, so rounding error can never enter the books.
5. **Every entry names its source.** Automatic postings carry the document
   that caused them, so any number traces back to an invoice or payment.

### What posting actually writes

Sending an invoice for 6,000 with 1,000 tax:

```
debit  Accounts Receivable  6000.00
credit Sales Revenue        5000.00
credit Tax Payable          1000.00
```

Tax is a liability, not income — it was never ours. Receiving payment moves
cash without touching revenue, because revenue was recognised at invoice time:

```
debit  Cash                 6000.00
credit Accounts Receivable  6000.00
```

## Human-in-the-loop

The assistant has no write access to the business. Its only mutating tool is
`/api/tools/erp/propose`, which stores a **proposal**: the exact operations
plus a plain-language preview. A person approves or rejects.

- Approval applies everything in one transaction. If any operation fails, the
  earlier ones roll back — a proposal never lands half-done.
- Undo walks an applied proposal back: records revert to their prior revision
  or soft-delete, and posted journal entries **reverse** rather than vanish,
  because the books do not rewrite history even to undo themselves.
- Added fields and created tables are deliberately *not* removed by undo.
  Dropping a column would destroy whatever anyone has since put in it, which
  is far worse than an unused field.

## Adding a field by asking

`add-field` is additive only: new fields arrive optional, so every existing
row stays valid without a backfill. That is what makes the request safe to
grant in seconds.

Making a field required, renaming it, or changing its type are different
operations with real blast radius. They are not implemented yet — see below.

## Saying what you want

`workspace-data/intent.ts` turns a sentence into the same `ProposalOperation[]`
the assistant emits, so "add a phone column to customers" and an agent proposal
travel the identical preview → approve → undo path.

It is a deterministic parser, not a model, and that is the load-bearing
decision. A statistical parser's failure mode is a confident wrong plan, and a
confident wrong plan is the one that gets approved without being read. So the
grammar is bounded, every result carries a `confidence` the UI must show, the
unmatched remainder of the sentence is reported rather than discarded, and
anything outside the grammar returns `unsupported` pointing at the assistant —
which has a real model behind it and goes through the same approval queue.

Two safety properties worth keeping:

- **Interpreting never writes.** `POST /assist/interpret` is pure. A misread
  sentence costs a glance, not a recovery.
- **Apply re-interprets.** `POST /assist/apply` does not trust the operations
  the client sends back; it re-runs the parser and refuses below
  `MIN_APPLY_CONFIDENCE`. Otherwise a tampered client could post any change it
  liked under cover of a harmless-looking sentence.

## Never losing data

Every write already stored a full snapshot in `od_record_revisions`, and SQLite
triggers make that table append-only *below* the application layer. What was
missing was a way to read that history and a way to return to a point in it.

`workspace-data/versions.ts` adds both. The rule that matters:

> **Restoring writes a new revision holding the old values.** It never rewinds
> the log, never deletes a revision, and never edits one.

So the timeline only grows. Restoring to revision 3 gives you revision 7 whose
contents equal revision 3's, and both are still there afterwards — which means
a restore is itself undoable, and an auditor is not asked to trust a history
that the restore button could rewrite.

Restore runs as an ordinary update, so the values are validated again (a
restore cannot reintroduce something the schema now forbids) and the audit
trail records who did it. Fields set *after* the target revision are cleared,
because "back to how it was" has to mean all of it.

## Packs a customer writes

The eight built-in packs are code. `workspace-data/packs.ts` stores packs of
the same shape per organization, so a customer who needs "Fleet" or "Clinics"
does not wait for us to write it — and the assistant can draft one on their
behalf through `POST /api/tools/erp/pack` (recorded as `origin: 'agent'` so a
reviewer can tell who wrote it).

Custom and built-in packs are listed together and install through the same
`installTemplate`, which is what makes a customer's pack a first-class part of
the product rather than a second-tier extension.

Because a spec arrives over HTTP and becomes real tables, validation is the
whole job and happens at **authoring** time, not install time: legal names, no
collision with existing tables, real field types, selects with options, links
that resolve. Every problem is reported at once — fixing one error per round
trip through an API is miserable. Storing a spec that cannot install would move
the failure to after someone pressed a button expecting it to work.

Deleting a pack deletes the definition only. A pack is a recipe; throwing away
the recipe does not throw away the meal, and the rows in those tables are the
customer's.

## Apps that can use the data

The obvious build is a scoped token plus a relaxed `connect-src`. This does not
do that.

A published app is untrusted code — a customer wrote it, or a model did. Giving
it a network means a bug or a hostile author has an authenticated channel, and
the token in the page is exfiltratable the moment any external origin becomes
reachable. The anonymous `/s/:token` path shares the same serving code, so a
mistake there leaks organization data to the internet.

So the app gets **no network at all**. `connect-src 'none'` is unchanged. The
app runs in an iframe sandboxed *without* `allow-same-origin` — opaque origin,
no cookies, no access to the host page — and asks for data by `postMessage`.
The host, already authenticated as the member looking at it, checks each
request against the scopes the app declared (`scopeAllows`) and then makes an
ordinary `/api/data/*` call.

Three consequences:

1. **An app cannot exfiltrate.** It cannot reach any origin, so data it is
   given cannot leave the page it was drawn in.
2. **An app cannot exceed the person running it.** The host uses that member's
   own session, so every tenancy and role check already in the daemon applies.
   There is no new privileged path to get wrong.
3. **Permission is legible.** Scopes are declared at publish, shown in plain
   words before the app runs, and every bridge call — allowed or refused — is
   listed in the activity panel.

Verified in a real browser, not just asserted: the sandbox yields an opaque
origin (reaching `parent.document` throws `SecurityError`) and CSP blocks the
network (`fetch` to an external host throws). Both are properties a unit test
cannot demonstrate.

`scopeAllows` denies by default: an unrecognised request kind is refused, so a
kind added to the union without being added to the gate fails closed.

## Reshaping a table that already holds data

The schema used to be append-only. You could add a field and never rename,
retype, or remove one — safe, and also why nobody could shape this system to
their own business: a field named by mistake stayed misnamed forever.

`workspace-data/schema-changes.ts` adds the destructive half, built on three
rules:

1. **Say what it will cost first.** `blastRadius` reports rows affected, values
   that cannot survive a type change (with samples), and everything referencing
   the field by name — formulas and saved views.
2. **Never silently discard.** A rename carries values across. A retype refuses
   by default and only drops data when the caller explicitly accepts the loss
   the preview described.
3. **Removal is reversible.** Removing marks the field removed and leaves the
   values in the record documents, so restoring brings the data back.

A rename is a real migration, not a metadata edit: field values live in
`od_records.data_json` keyed by field name and unique constraints are
expression indexes over `json_extract(data_json, '$.name')`. So it rewrites
every document key, rebuilds the index, rewrites formulas and views that named
the field, and updates the field row — in one transaction, because a
half-renamed table is unreadable. An auto-derived label follows the rename; a
label someone chose is left alone.

Refusals worth knowing: a select option still in use cannot be removed, and a
field cannot be made required while rows are missing it. Both would otherwise
make rows unsaveable through no fault of whoever owns them.

## Remaining work

1. **Line items.** Quotes, orders, and invoices carry a single total today. A
   real quote has lines, and revenue recognition by line is what makes
   category reporting possible. This is the largest gap.
2. **Schema changes have no UI yet.** Rename, retype, remove, restore,
   reorder, and field config are on the API, the CLI (`od erp field`), and the
   sentence parser ("rename phone to mobile"), but there is no field editor
   screen — so today reshaping a table is a CLI or command-bar action, not a
   click.
3. **Natural language → query.** Saved questions store structured queries and
   the API accepts them, but nothing yet turns "how much is overdue?" into
   that structure. The agent can do it through `propose`; a dedicated
   ask-endpoint would be better.
4. **Aged receivables and P&L.** The trial balance is in, and aged *payables*
   now ship (`workspace-data/payables.ts`). The receivables mirror and the P&L
   are not built.
5. **The ledger is SQLite-only.** `workspace-data/ledger.ts` is written
   against `SqlExecutor`, so it is ready for Postgres, but the schema
   (`storage/postgres-schema.ts`) does not yet include the ledger tables. See
   `specs/current/organizations-on-supabase.md`. Team chat *is* mirrored in
   both dialects (SQLite `WORKSPACE_MIGRATIONS` v5, Postgres `0006-team-chat`).
6. **Chat realtime is polling.** `TeamChatView` polls every 5s while the tab
   is visible. The record-change SSE stream (`GET /api/data/events`) is the
   obvious upgrade; polling was chosen first because it degrades to "slightly
   late" rather than to "silently disconnected".
7. **The parser's grammar is small.** It covers adding fields and rows,
   creating tables, filtering, sorting, and grouping — the phrasings people
   repeat. Deleting, renaming, bulk edits, and joins are not in it, and
   deliberately fall through to the assistant rather than being guessed at.
8. **Formulas are one level deep.** A formula that references another formula
   field reads `null` rather than chaining. Evaluation then obviously
   terminates; the alternative is a dependency graph with cycle detection at
   read time, which nobody has asked for yet.
9. **Rollups reach the record page, not the grid.** `related.ts` totals a
   record's related lists ("invoiced: 42,500.00"), but a rollup *field* on a
   table — a column that sums a link — still is not materialized by the record
   reader. `computeRollup` is written and tested for when it is.
   Related-list totals read up to `AGGREGATE_LIMIT` rows; past that the count
   is a floor and `truncated` says so.
10. **Per-pack UI depth varies.** Sales, CRM, purchasing, inventory, jobs,
   chat, and the books have purpose-built screens; every pack is also
   editable through the Tables screen and the record page. Expenses, people,
   and support have no bespoke module screen yet.
11. **The app runtime has no authoring surface yet.** An app declares
   `dataScopes` at publish and the runtime enforces them, but nothing in the
   UI helps someone *write* an app against the `od` SDK — no template, no
   scaffold, no scope picker. The assistant can write the HTML; there is no
   guided path.
12. **Bridge reads are unpaged.** `od.query` caps at 500 rows and there is no
   cursor, so an app cannot walk a large table.
12. **The record page has no "new related record" button.** A related list
   carries `viaField` precisely so a create can prefill it, and nothing uses
   that yet — you add the row from the owning tab instead.
8. **Partial UI.** The main workspace view is built
   (`apps/web/src/components/workspace-home/`): search across every table,
   recent documents, create-from-schema, the tool builder, pending proposals
   with their previews, and pinned answers. The dedicated books surfaces
   (chart of accounts, journal, trial balance, period close) are not.

## Surfaces

Every capability here is reachable three ways, per the capability-closure rule
in `AGENTS.md`:

- **HTTP** — `apps/daemon/src/routes/erp.ts`, typed by
  `packages/contracts/src/api/{business-hub,ledger,proposals}.ts`.
- **Web** — `apps/web/src/components/workspace-home/`, plus
  `components/{templates,crm,purchasing,team,books,approvals}/`.
- **CLI** — `od erp` (`apps/daemon/src/cli.ts`), covering `search`, `recent`,
  `template`, `crm`, `purchasing`, `inventory`, `projects`, `hub`, `ledger`,
  `proposals`, `questions`, `widgets`, `import`, `ask`, `views`, `record`,
  `history`, `pack`, and `field`; plus `od team` for chat.
  Every verb takes `--json`, `import` reads `--file <path|->`, and
  `od team post` reads `--prompt-file <path|->`.

Two CLI behaviors are worth knowing because they mirror deliberate product
decisions rather than API shapes:

- `hub convert` drafts the next document and prints it; it saves only with
  `--save`. Converting a quote is a decision, not a side effect.
- `proposals undo` reverses data but reports that a new field or table was
  left in place. Dropping it would destroy whatever anyone has since stored
  there, which is worse than an unused column.
- `template install` is additive and never overwrites. A table that already
  exists is reported as skipped and left exactly as the organization has
  customized it, which is what makes installing `purchasing` a year after
  `sales` safe and re-running an install the way to pick up a table a pack has
  since gained.
- `od erp ask` shows what a sentence would do and stops; `--save` applies it.
  Same shape as `hub convert`: seeing the change and choosing it are separate
  steps. A question (`show overdue invoices`) runs immediately, because reading
  changes nothing and there is nothing to confirm.
- `od erp history <id> --restore <n>` adds a version rather than rewinding, so
  the step back is itself in the history and can be stepped back out of.
- `od team post` does not mark the channel read. Posting from a script is not
  evidence anyone read what was said while they were away; only opening the
  channel in the UI, or `od team read`, moves the marker.
