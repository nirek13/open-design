# Linear tracker checklist

Run this before the canonical filesystem or `text_artifact` handoff.
P0 = must pass; P1 = should pass.

## P0 — must pass

- [ ] **Looks like Linear product UI, not a landing page.** Dark canvas,
      36px rows, Inter at UI sizes, indigo accent only on active rail /
      primary create. No hero, no feature grid, no 64px Inter display.
- [ ] **No purple/violet gradients.** Accent is flat `#5e6ad2` / `#7170ff`.
- [ ] **No emoji as icons.** Status is the ring/dot system from the
      example. Priority is four vertical bars. Nav uses the example's
      SVG marks.
- [ ] **No lorem ipsum.** Issue titles read like real production work
      (auth regression, updater registry, i18n keys) — not "Task 1".
- [ ] **Identifiers are real-shaped.** `OD-214`, `ENG-18`, `DES-9` — never
      `T-1` or `#123`.
- [ ] **List and board both work.** Switching views does not lose the
      selected issue or the search filter.
- [ ] **Create works.** `c` or the New issue control opens the dialog;
      submitting adds a row and persists.
- [ ] **Empty / filtered empty states exist.** Searching for a string
      with no hits does not render a blank void.
- [ ] **No `scrollIntoView()`.** Breaks the Open Design preview iframe.
- [ ] **`window.od` is optional.** Missing SDK still works via
      localStorage. Calls use string literals `api.query('issues'`,
      `api.create('issues'`, `api.update('issues'`.

## P1 — should pass

- [ ] **Keyboard:** `/` search, `j`/`k` move, `l` list, `b` board,
      `Escape` closes dialogs and does not leak.
- [ ] **Cycle strip** shows name, percent complete, days left.
- [ ] **Hover and selected row** are distinguishable.
- [ ] **Canceled issues** are struck and excluded from Active.
- [ ] **Theme toggle** swaps dark/light using the example tokens.

## Anti-slop spot-check

If the page looks like a generic SaaS kanban with pastel cards and a
purple gradient sidebar, start over from `example.html`.
