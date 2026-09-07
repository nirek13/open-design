// Shared prompt wrapper so every wiki-building entry (Pages Ask AI,
// Home wiki chip, Tool Builder) sends the same agent instructions.

import { composePageMakeRequest, type PageMakeKind } from '../../runtime/page-make';

export function composePagesWikiPrompt(input: {
  request: string;
  pageId?: string | null;
  pageTitle?: string | null;
  pageIcon?: string | null;
  pageExcerpt?: string | null;
  make?: { kind: PageMakeKind; prompt: string };
}): string {
  const request = input.request.trim();
  const lines = [
    'You are building a Notion-shaped organization wiki using `tools pages` (nested pages, typed blocks, embeds). Do not invent markdown or HTML files for this — write through the pages API so the Pages view can open the result.',
    '',
    'Workflow:',
    '1. Discover first: `"$OD_NODE_BIN" "$OD_BIN" tools pages list --tree`, then `tools pages search --query <text>` and `tools pages get --page <id>`. Reuse pages that already fit.',
    '2. Scaffold the tree in one call with `tools pages scaffold --input tree.json` using nested `{title, icon, cover, blocks, children}`.',
    '3. Fill pages with headings, lists, to-dos, toggles, callouts, quotes, code, dividers, images, equations, tables of contents, columns, bookmarks, live embeds, inline tables, and page tools (`board` kanban, `checklist`, `assigner`, `poll`, `timeline`, `decision`, `goals`). Creating a child page automatically embeds it on the parent (a page-in-a-page) unless you pass `linkOnParent: false`. Tool payloads live in the block `content` object (see `tools pages --help`).',
    '4. Embed other things inside pages with `tools pages embed --page <id> --type page|database|record|artifact|bookmark|embed` plus `--target` (page id), `--table`, `--record`, `--path`, or `--url`. Prefer `--type embed --url` for YouTube, Figma, Notion, Google Docs/Slides, PDFs, and anything you created in this workspace. For a created app, picture, video, or HTML slides, pass `--url /api/projects/<projectId>/raw/<file>` (png/jpg/mp4/html). Nested `page` embeds put pages inside pages; `database` is a live workspace table; `artifact` can use that same `/raw/` URL as `--path`.',
    '5. Prefer `tools pages append` for additive edits and `tools pages upsert` when replacing a page body. See `tools pages --help` for payload shapes.',
    '6. When asked to make an app, picture, video, or slides, generate a unique file in this project (do not reuse a generic template unchanged) and embed it on the current page with `tools pages embed --page <id> --type embed --url /api/projects/<this project id>/raw/<file>`. Do not stop at a description.',
    '',
  ];
  if (input.pageId) {
    const title = input.pageTitle?.trim();
    const icon = input.pageIcon?.trim();
    lines.push(
      `Current page context: ${icon ? `${icon} ` : ''}${title || 'Untitled'} (id ${input.pageId}). Prefer editing this page and nesting children under it. The user is looking at this page right now.`,
      '',
    );
    const excerpt = input.pageExcerpt?.trim();
    if (excerpt) {
      lines.push('Current page body (excerpt, may be stale if they keep typing):', '```', excerpt, '```', '');
    }
  }
  if (input.make) {
    lines.push(composePageMakeRequest(input.make.kind, input.make.prompt), '');
  }
  lines.push('User request:', request || 'Build a useful nested wiki for this organization.');
  return lines.join('\n');
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
