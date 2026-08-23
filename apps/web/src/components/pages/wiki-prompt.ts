// Shared prompt wrapper so every wiki-building entry (Pages Ask AI,
// Home wiki chip, Tool Builder) sends the same agent instructions.

export function composePagesWikiPrompt(input: {
  request: string;
  pageId?: string | null;
  pageTitle?: string | null;
  pageIcon?: string | null;
  pageExcerpt?: string | null;
}): string {
  const request = input.request.trim();
  const lines = [
    'You are building a Notion-shaped organization wiki using `tools pages` (nested pages, typed blocks, embeds). Do not invent markdown or HTML files for this — write through the pages API so the Pages view can open the result.',
    '',
    'Workflow:',
    '1. Discover first: `"$OD_NODE_BIN" "$OD_BIN" tools pages list --tree`, then `tools pages search --query <text>` and `tools pages get --page <id>`. Reuse pages that already fit.',
    '2. Scaffold the tree in one call with `tools pages scaffold --input tree.json` using nested `{title, icon, cover, blocks, children}`.',
    '3. Fill pages with headings, lists, to-dos, toggles, callouts, quotes, code, dividers, bookmarks, and inline tables. Creating a child page automatically embeds it on the parent (a page-in-a-page) unless you pass `linkOnParent: false`.',
    '4. Embed other things inside pages with `tools pages embed --page <id> --type page|database|record|artifact|bookmark` plus `--target` (page id), `--table`, `--record`, `--path`, or `--url`. Nested `page` embeds are how you put pages inside pages; `database` is a live workspace table; `artifact` points at a design file you built in this project.',
    '5. Prefer `tools pages append` for additive edits and `tools pages upsert` when replacing a page body. See `tools pages --help` for payload shapes.',
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
