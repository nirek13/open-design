// Shared prompt wrapper so every wiki-building entry (Pages Ask AI,
// Home wiki chip, Tool Builder) sends the same agent instructions.

import { composePageMakeRequest, type PageMakeKind } from '../../runtime/page-make';

export function composePagesWikiPrompt(input: {
  request: string;
  pageId?: string | null;
  pageTitle?: string | null;
  pageIcon?: string | null;
  pageExcerpt?: string | null;
  projectId?: string | null;
  openTabs?: Array<{ id: string; title?: string | null; icon?: string | null }>;
  make?: { kind: PageMakeKind; prompt: string };
}): string {
  const request = input.request.trim();
  const projectId = input.projectId?.trim() || '$OD_PROJECT_ID';
  const pageId = input.pageId?.trim();
  const lines = [
    'You are building a Notion-shaped organization wiki using `tools pages` (nested pages, typed blocks, embeds). Do not invent markdown or HTML files for this — write through the pages API so the Pages view can open the result.',
    '',
    'Native tools first: when the user wants a tool, tracker, dashboard, kanban, sprint board, checklist, assignment board, poll, vote, timeline, roadmap, decision log, OKR, goals, spreadsheet, budget, calendar, habit tracker, countdown, or weekly schedule, append a native page-tool block — `board`, `checklist`, `assigner`, `poll`, `timeline`, `decision`, `goals`, `spreadsheet`, `budget`, `calendar`, `habit`, `countdown`, or `schedule` — with a filled `content` object (see `tools pages --help`). Do not generate HTML/JS and embed it as an artifact or live preview when a native tool fits.',
    '',
    'Every `tools pages` command must be run as `"$OD_NODE_BIN" "$OD_BIN" tools pages …`. Writing a JSON payload to a file is not done — you must execute append/upsert/embed/scaffold in the same turn, then `"$OD_NODE_BIN" "$OD_BIN" tools pages get --page <id>` and keep going until the returned blocks show the change. Do not stop after describing what you will do. Goals use `content.items` (`title`, `current`, `target`, `unit`), not a `goals`/`status` array.',
    '',
    'Workflow:',
    '1. Discover first: `"$OD_NODE_BIN" "$OD_BIN" tools pages list --tree`, then `"$OD_NODE_BIN" "$OD_BIN" tools pages search --query <text>` and `"$OD_NODE_BIN" "$OD_BIN" tools pages get --page <id>`. Reuse pages that already fit.',
    '2. Scaffold the tree in one call with `"$OD_NODE_BIN" "$OD_BIN" tools pages scaffold --input tree.json` using nested `{title, icon, cover, blocks, children}`.',
    '3. Fill pages with headings, lists, to-dos, toggles, callouts, quotes, code, dividers, images, equations, tables of contents, columns, bookmarks, live embeds, inline tables, and those native page tools. Creating a child page automatically embeds it on the parent (a page-in-a-page) unless you pass `linkOnParent: false`. Tool payloads live in the block `content` object (see `"$OD_NODE_BIN" "$OD_BIN" tools pages --help`).',
    '4. Embed other things inside pages with `"$OD_NODE_BIN" "$OD_BIN" tools pages embed --page <id> --type page|database|record|artifact|bookmark|embed` plus `--target` (page id), `--table`, `--record`, `--path`, or `--url`. Prefer `--type embed --url` for YouTube, Figma, Notion, Google Docs/Slides, and PDFs. Nested `page` embeds put pages inside pages; `database` is a live workspace table.',
    '5. Prefer `"$OD_NODE_BIN" "$OD_BIN" tools pages append --page <id> --input blocks.json` for additive edits and `"$OD_NODE_BIN" "$OD_BIN" tools pages upsert` when replacing a page body. See `"$OD_NODE_BIN" "$OD_BIN" tools pages --help` for payload shapes.',
      `6. Generate a project file and embed it only when native page tools cannot express the request: a picture, video, slide deck, chart, diagram, or a custom interactive app whose UI is not a board/checklist/assigner/poll/timeline/decision/goals/spreadsheet/budget/calendar/habit/countdown/schedule. Then generate a unique file (do not reuse a generic template unchanged) and embed it with \`tools pages embed --page ${pageId || '<id>'} --type embed --url /api/projects/${projectId}/raw/<file>\` (png/jpg/svg/mp4/html). A file that only exists in this chat project is not done. Do not stop at a description.`,
    '',
    'Visibility (required): every user-visible change must land on a page they can see in the notes tab bar at the top of Pages. That means the current open tab, another page already open as a tab, or a NEW page you create (a child of the current page, or a new root if there is no current page) — the new page will open as a tab. Do not edit other existing pages that are not in the tab bar. A generated file is unfinished until it is embedded on that visible page.',
    '',
  ];
  if (input.projectId?.trim()) {
    lines.push(
      `This chat project id is ${input.projectId.trim()} (also in $OD_PROJECT_ID). Use it in /api/projects/${input.projectId.trim()}/raw/<file> embed URLs.`,
      '',
    );
  }
  const openTabs = (input.openTabs ?? []).filter((tab) => tab.id.trim());
  if (openTabs.length > 0) {
    lines.push(
      `Notes tab bar (pages currently open as tabs): ${openTabs
        .map((tab) => formatPageRef(tab))
        .join('; ')}.`,
      '',
    );
  }
  if (input.pageId) {
    lines.push(
      `Current page context: ${formatPageRef({
        id: input.pageId,
        title: input.pageTitle,
        icon: input.pageIcon,
      })}. This is the active tab in the notes tab bar. Put work on this page, or create a new child under it (\`parentPageId: ${input.pageId}\`) so the new page opens as a tab. You may also edit other pages listed in the notes tab bar. Do not edit unrelated existing pages.`,
      '',
    );
    const excerpt = input.pageExcerpt?.trim();
    if (excerpt) {
      lines.push('Current page body (excerpt, may be stale if they keep typing):', '```', excerpt, '```', '');
    }
  }
  if (input.make) {
    lines.push(
      composePageMakeRequest(input.make.kind, input.make.prompt, {
        pageId: input.pageId,
        projectId: input.projectId,
      }),
      '',
    );
  }
  lines.push('User request:', request || 'Build a useful nested wiki for this organization.');
  return lines.join('\n');
}

function formatPageRef(page: { id: string; title?: string | null; icon?: string | null }): string {
  const title = page.title?.trim() || 'Untitled';
  const icon = page.icon?.trim();
  return `${icon ? `${icon} ` : ''}${title} (id ${page.id})`;
}

export function draftBlocksPlainText(
  blocks: Array<{ text?: string; children?: unknown[] }>,
  limit = 1600,
): string {
  const parts: string[] = [];
  const walk = (list: Array<{ text?: string; children?: unknown[] }>) => {
    for (const block of list) {
      const text = typeof block.text === 'string' ? block.text.trim() : '';
      if (text) parts.push(text);
      if (Array.isArray(block.children) && block.children.length > 0) {
        walk(block.children as Array<{ text?: string; children?: unknown[] }>);
      }
    }
  };
  walk(blocks);
  const joined = parts.join('\n');
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
}
