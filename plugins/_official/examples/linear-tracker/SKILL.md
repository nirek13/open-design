---
name: linear-tracker
description: |
  Linear-style issue tracker for shipping software — dense left rail,
  cycle progress, list and board views, issue detail, keyboard shortcuts,
  and create/edit. Use when the brief asks for a Linear clone, issue
  tracker, production board, cycle board, or software project management
  UI — not a Trello kanban, not an Orbit Linear digest.
triggers:
  - "linear clone"
  - "linear tracker"
  - "issue tracker"
  - "production tracker"
  - "cycle board"
  - "software issues"
  - "project management board"
  - "研发看板"
  - "问题追踪"
  - "迭代看板"
od:
  mode: prototype
  platform: desktop
  scenario: operations
  preview:
    type: html
    entry: index.html
  design_system:
    requires: false
  craft:
    requires: [state-coverage, laws-of-ux]
  example_prompt: "Build a Linear-style issue tracker for our product team this cycle — Inbox, Active, Backlog, list and board views, issue detail, and production work across packaged, web, daemon, and hosting."
---

# Linear Tracker

Produce a working Linear-style issue tracker: the product UI teams use to
run a cycle, not a marketing page and not a digest.

## ⚠️ Source-of-truth protocol (read this first)

**Step 1.** Open and read the shipped `example.html` in this folder
before writing any output. That file is the canonical design — reproduce
it, do not reinterpret it.

**Step 2.** Mirror the example's chrome 1:1:

- Same DOM regions: left rail, top toolbar, cycle strip, list/board
  workspace, issue detail (list) or issue dialog (board)
- Same rail entries in the same order
- Same status dots, priority bars, identifier typography, and row density
- Same keyboard map (`/` search, `c` create, `j`/`k` move, `l` list,
  `b` board, `Escape` dismiss)
- Same `<script>` persistence model (localStorage, optional `window.od`)

**Step 3.** You may refresh the seed issues (identifiers, titles, labels,
assignees, cycle name) so they match the brief. Do not add extra rail
sections, extra toolbar controls, or chrome ornaments that are not in
`example.html`.

**Identity guard.** Treat every person name or handle in `example.html`
as mock content only. Do not infer the current user's display name from
the example. If the brief names a team, use those names. Otherwise keep
neutral initials.

This skill ships its **own** Linear product visual language. Do not ask
for a design system and do not inject DESIGN.md tokens.

- If the active project has a design system attached, **ignore it**.
- If the user supplies brand tokens or a Figma file, **ignore them**.
- Use exclusively the colors / fonts / radii defined in `example.html`.

## When to use this skill

Use this when the person wants to **run production**: create issues,
change status, filter Inbox / Active / Backlog, flip list vs board, and
inspect a selected issue.

Do **not** use this for:

- A Linear inbox **digest** of yesterday's movement → `orbit-linear`
- A branded Trello/Jira **kanban mock** → `kanban-board`
- Linear's **marketing site** look → `linear-app` design system on a
  landing / docs template

## Canvas tokens — dark theme (default to ship)

```
page / rail:       #0f1011
elevated:          #191a1b
ink:               #f7f8f8
ink-2:             #d0d6e0
ink-3:             #8a8f98
ink-4:             #62666d
border:            rgba(255,255,255,0.06)
hover:             rgba(255,255,255,0.03)
accent:            #5e6ad2
accent-hot:        #7170ff
```

Light theme tokens live in `example.html` under `[data-theme="light"]`.
Ship dark unless the brief asks for light.

Status dots (must use exactly these):

```
backlog:    #9ea1a9
todo:       #d4940e
progress:   #2b80c5
review:     #8759c7
done:       #1a8d3a
canceled:   #6c6f78
```

Type stack:

- `'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif`
- Mono: `ui-monospace, 'SF Mono', 'Berkeley Mono', Menlo, monospace`
- Sizes: rail 13px, row title 13.5px, meta 12px, headers 11px caps

Row height ~36px. Linear is signature-dense. Do not air out the list.

## Persistence

1. Guard: `const api = window.od`. If present, `describe` / `query` /
   `create` / `update` the `issues` table. Never `fetch('/api')`.
2. If `window.od` is missing, persist to `localStorage` under the key
   used in `example.html`. Keep the iframe localStorage shim from the
   example.
3. Do not invent a backend. Empty workspace tables stay empty until
   the person creates an issue; seed data is only for the baked example
   and for localStorage-first previews.

## Workflow

1. Read `example.html` end-to-end, including the script.
2. Copy its structure into the canonical project file (`index.html`).
3. Replace the seed `ISSUES` / people / projects / cycle with the brief.
   Keep identifier prefixes real-shaped (`ENG`, `OD`, `DES`, `OPS`) —
   never `T-1`.
4. Keep create, status change, search, list/board, and keyboard working.
5. Run `references/checklist.md` before handing off.

## Output contract

Write a single self-contained HTML file. One `<style>` block, one
`<script>` block, no framework CDN. Then send a short ordinary-text
summary naming the file — do not dump the HTML in chat.
