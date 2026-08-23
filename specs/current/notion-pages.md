# Substrate pages (Notion-esque notes)

## Product name

User-facing product brand is **Substrate**. The monorepo / npm scope remains
`@open-design/*` so packaging and imports stay stable. Display strings
(`app.brand`, window titles, Pages copy) say Substrate.

## Why

Notion’s flexibility comes from one idea: **everything is a block** — text,
headings, todos, toggles, database rows, even pages — each with a type,
properties, and ordered children
([Notion engineering](https://www.notion.com/blog/data-model-behind-notion),
[Notion API blocks](https://developers.notion.com/reference/block)).

Substrate already had Notion-shaped **databases** (workspace tables + views).
Pages are the **document half**: a nested page tree whose body is a block
canvas, with slash insertion, Enter/Backspace flow, and embeds into org tables
and design artifacts.

## Interaction model (MVP editor)

| Gesture | Behavior |
| --- | --- |
| `/` at line start | Slash catalogue (Notion “basic blocks”) |
| Enter | New sibling block (lists/todos continue type; toggles add a child) |
| Backspace on empty | Convert to paragraph, then remove / focus previous |
| Hover gutter | Move ↑↓ and `+` insert |
| Title / icon | Autosaved with the block tree (~700ms debounce) |

## Block catalogue

Aligned with Notion’s public vocabulary where possible, plus Substrate bridges:

- `paragraph`, `heading_1..3`, `bulleted_list_item`, `numbered_list_item`
- `to_do`, `toggle`, `callout`, `quote`, `code`, `divider`, `bookmark`
- `table` — inline JSON grid owned by the page
- `database` — embed org workspace table by id
- `artifact` — link a project design file
- `page` — link another Substrate page

## Surfaces

| Layer | Path |
| --- | --- |
| Spec | this file |
| Contracts | `packages/contracts/src/api/pages.ts` |
| Storage | `od_pages` / `od_blocks` (workspace-db v9) |
| Daemon | `workspace-data/pages.ts`, `routes/pages.ts` |
| Agent tools | `/api/tools/pages/list\|get\|upsert` |
| CLI | `od pages …` |
| UI | `apps/web/src/components/pages/{PagesView,BlockEditor}.*` |

## Agent guidance

Prefer pages tools when the user wants durable notes/docs. Prefer design
artifacts / Write when they want a **designed** HTML app or deck. Use a
`database` block when the data should live in org tables.

## Non-goals (still later)

Realtime multiplayer / CRDT, synced blocks, comments, permissions per page,
full Notion import/export, Lexical rich marks inside every block.
