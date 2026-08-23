// Agent-facing CLI wrapper for organization pages (Notion-shaped wiki).
// Invoked from agent runs as:
//   "$OD_NODE_BIN" "$OD_BIN" tools pages <verb> ...
// Auth rides the per-run OD_TOOL_TOKEN bearer; the daemon derives workspace
// scope and actor attribution from the grant, never from arguments.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

const PAGES_USAGE = `Usage:
  od tools pages list [--tree]
  od tools pages get --page <page-id>
  od tools pages search --query <text> [--limit <n>]
  od tools pages upsert --input page.json
  od tools pages append --page <page-id> --input blocks.json
  od tools pages embed --page <page-id> --type <page|database|record|artifact|bookmark> [--target <id>] [--table <id>] [--record <id>] [--path <file>] [--url <url>]
  od tools pages scaffold --input tree.json
  od tools pages duplicate --page <page-id> [--recursive]
  od tools pages archive --page <page-id>

Input files:
  upsert     {"title":"Handbook","parentPageId":null,"icon":"📘","blocks":[{"type":"heading_1","content":"Welcome"}]}
             Pass pageId to update an existing page's title/icon/blocks.
  append     {"blocks":[{"type":"paragraph","content":"Shipped."}]}
             Or a bare blocks array.
  scaffold   {"parentPageId":null,"pages":[{"title":"Wiki","icon":"📚","children":[{"title":"Onboarding"}]}]}
  Pass --input - to read the JSON payload from stdin.

Block types:
  paragraph, heading_1, heading_2, heading_3, bulleted_list_item,
  numbered_list_item, to_do, toggle, callout, quote, code, divider,
  bookmark, table, database, artifact, page, record.

Embeds:
  page       props.pageId     — nested page / wiki link
  database   props.tableId    — live workspace table
  record     props.recordId   — one ERP / workspace row
  artifact   props.path       — project design file
  bookmark   props.url        — external URL card

Creating a child page with parentPageId also appends a page embed on the parent
unless you set linkOnParent: false.

Environment:
  OD_NODE_BIN     Node-compatible runtime for agent wrapper invocations
  OD_BIN          Open Design CLI script for agent wrapper invocations
  OD_DAEMON_URL   Daemon base URL injected into agent runs
  OD_TOOL_TOKEN   Bearer token injected into agent runs
`;

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, details?: unknown): ToolCliResult {
  writeJson({ ok: false, error: { message, ...(details === undefined ? {} : { details }) } }, process.stderr);
  return { exitCode: 1 };
}

function daemonUrl(): URL | { error: string } {
  const rawUrl = process.env.OD_DAEMON_URL;
  if (!rawUrl) return { error: 'OD_DAEMON_URL is required' };
  try {
    const url = new URL(rawUrl);
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return { error: 'OD_DAEMON_URL must be a valid URL' };
  }
}

function toolToken(): string | { error: string } {
  const token = process.env.OD_TOOL_TOKEN;
  if (!token) return { error: 'OD_TOOL_TOKEN is required' };
  return token;
}

async function readInputJson(inputPath: string): Promise<unknown> {
  let text: string;
  if (inputPath === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await readFile(path.resolve(inputPath), 'utf8');
  }
  return JSON.parse(text) as unknown;
}

interface ParsedPagesOptions {
  command: string | undefined;
  page?: string;
  query?: string;
  limit?: number;
  inputPath?: string;
  type?: string;
  target?: string;
  table?: string;
  record?: string;
  filePath?: string;
  url?: string;
  tree: boolean;
  recursive: boolean;
  help: boolean;
}

function parseOptions(args: string[]): ParsedPagesOptions | { error: string } {
  const [command, ...rest] = args;
  const options: ParsedPagesOptions = {
    command: command === '-h' || command === '--help' ? undefined : command,
    help: command === '-h' || command === '--help',
    tree: false,
    recursive: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--page') {
      const value = rest[++index];
      if (!value) return { error: '--page requires a page id' };
      options.page = value;
    } else if (arg === '--query' || arg === '-q') {
      const value = rest[++index];
      if (!value) return { error: '--query requires text' };
      options.query = value;
    } else if (arg === '--limit') {
      const value = rest[++index];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1) return { error: '--limit must be a positive integer' };
      options.limit = parsed;
    } else if (arg === '--input') {
      const value = rest[++index];
      if (!value) return { error: '--input requires a file path or -' };
      options.inputPath = value;
    } else if (arg === '--type') {
      const value = rest[++index];
      if (!value) return { error: '--type requires an embed kind' };
      options.type = value;
    } else if (arg === '--target') {
      const value = rest[++index];
      if (!value) return { error: '--target requires a page id' };
      options.target = value;
    } else if (arg === '--table') {
      const value = rest[++index];
      if (!value) return { error: '--table requires a table id' };
      options.table = value;
    } else if (arg === '--record') {
      const value = rest[++index];
      if (!value) return { error: '--record requires a record id' };
      options.record = value;
    } else if (arg === '--path') {
      const value = rest[++index];
      if (!value) return { error: '--path requires an artifact path' };
      options.filePath = value;
    } else if (arg === '--url') {
      const value = rest[++index];
      if (!value) return { error: '--url requires a URL' };
      options.url = value;
    } else if (arg === '--tree') {
      options.tree = true;
    } else if (arg === '--recursive') {
      options.recursive = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      return { error: `unknown option: ${arg}` };
    }
  }
  return options;
}

async function post(baseUrl: URL, token: string, pathname: string, body: JsonObject): Promise<ToolCliResult> {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname}${pathname}`.replace(/\/+/gu, '/');
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { message: text };
    }
  }
  if (response.status >= 200 && response.status < 300) {
    writeJson({ ok: true, ...(parsed as JsonObject) });
    return { exitCode: 0 };
  }
  const errorBody = (parsed as JsonObject)?.error ?? parsed;
  writeJson({ ok: false, status: response.status, error: errorBody }, process.stderr);
  return { exitCode: 1 };
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be a JSON object');
  }
  return value as JsonObject;
}

export async function runPagesToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(PAGES_USAGE);
    return { exitCode: options.command || options.help ? 0 : 1 };
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  try {
    switch (options.command) {
      case 'list':
        return await post(baseUrl, token, '/api/tools/pages/list', { tree: options.tree });
      case 'get': {
        if (!options.page) return fail('get requires --page');
        return await post(baseUrl, token, '/api/tools/pages/get', { pageId: options.page });
      }
      case 'search': {
        if (!options.query) return fail('search requires --query');
        return await post(baseUrl, token, '/api/tools/pages/search', {
          query: options.query,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        });
      }
      case 'upsert': {
        if (!options.inputPath) return fail('upsert requires --input with the page JSON');
        const payload = asObject(await readInputJson(options.inputPath));
        return await post(baseUrl, token, '/api/tools/pages/upsert', payload);
      }
      case 'append': {
        if (!options.page) return fail('append requires --page');
        if (!options.inputPath) return fail('append requires --input with { "blocks": [...] } or a blocks array');
        const raw = await readInputJson(options.inputPath);
        const blocks = Array.isArray(raw) ? raw : asObject(raw).blocks;
        return await post(baseUrl, token, '/api/tools/pages/append', { pageId: options.page, blocks });
      }
      case 'embed': {
        if (!options.page) return fail('embed requires --page');
        if (!options.type) return fail('embed requires --type');
        return await post(baseUrl, token, '/api/tools/pages/embed', {
          pageId: options.page,
          type: options.type,
          targetPageId: options.target,
          tableId: options.table,
          recordId: options.record,
          path: options.filePath,
          url: options.url,
        });
      }
      case 'scaffold': {
        if (!options.inputPath) return fail('scaffold requires --input with the wiki tree JSON');
        const payload = asObject(await readInputJson(options.inputPath));
        return await post(baseUrl, token, '/api/tools/pages/scaffold', payload);
      }
      case 'duplicate': {
        if (!options.page) return fail('duplicate requires --page');
        return await post(baseUrl, token, '/api/tools/pages/duplicate', {
          pageId: options.page,
          recursive: options.recursive,
        });
      }
      case 'archive': {
        if (!options.page) return fail('archive requires --page');
        return await post(baseUrl, token, '/api/tools/pages/archive', { pageId: options.page });
      }
      default:
        return fail(`unknown command: ${options.command}\n${PAGES_USAGE}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
