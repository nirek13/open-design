// Agent-facing CLI wrapper for ERP: magic-import a URL, apply a sentence to
// tables, and define/install custom packs. Invoked from agent runs as:
//   "$OD_NODE_BIN" "$OD_BIN" tools erp <verb> ...
// Auth rides the per-run OD_TOOL_TOKEN bearer.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

const ERP_USAGE = `Usage:
  od tools erp import-url --url <https://...> [--table <name>] [--plan-only]
  od tools erp ask --text "<what to change or find>" [--table <name>] [--apply]
  od tools erp pack --input spec.json [--slug <slug>]
  od tools erp pack-install --pack <slug>
  od tools erp preview --input operations.json
  od tools erp propose --input proposal.json

Magic import:
  Pulls a public Google Sheet, CSV, JSON, HTML table, open-data dump, or any
  public page (AI scrapes unstructured pages into rows) and creates a
  workspace table. Re-importing the same link updates matching unique keys
  instead of duplicating rows. Default commits. Pass --plan-only to preview.

Ask:
  Interprets a sentence against the live schema. Queries run immediately.
  Pass --apply to make schema/record changes (undoable proposal).

Pack:
  spec.json is { displayName, description?, tables: [{ name, displayName, fields }] }.
  pack-install turns a saved definition into real tables.

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

async function readInputJson(inputPath: string): Promise<JsonObject> {
  let text: string;
  if (inputPath === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await readFile(path.resolve(inputPath), 'utf8');
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be a JSON object');
  }
  return value as JsonObject;
}

interface ParsedErpOptions {
  command: string | undefined;
  url?: string;
  table?: string;
  text?: string;
  pack?: string;
  slug?: string;
  inputPath?: string;
  planOnly: boolean;
  apply: boolean;
  help: boolean;
}

function parseOptions(args: string[]): ParsedErpOptions | { error: string } {
  const [command, ...rest] = args;
  const options: ParsedErpOptions = {
    command: command === '-h' || command === '--help' ? undefined : command,
    help: command === '-h' || command === '--help',
    planOnly: false,
    apply: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--url') {
      const value = rest[++index];
      if (!value) return { error: '--url requires a link' };
      options.url = value;
    } else if (arg === '--table') {
      const value = rest[++index];
      if (!value) return { error: '--table requires a table name' };
      options.table = value;
    } else if (arg === '--text') {
      const value = rest[++index];
      if (!value) return { error: '--text requires a sentence' };
      options.text = value;
    } else if (arg === '--pack' || arg === '--slug') {
      const value = rest[++index];
      if (!value) return { error: `${arg} requires a pack slug` };
      options.pack = value;
      if (arg === '--slug') options.slug = value;
    } else if (arg === '--input') {
      const value = rest[++index];
      if (!value) return { error: '--input requires a file path or -' };
      options.inputPath = value;
    } else if (arg === '--plan-only') {
      options.planOnly = true;
    } else if (arg === '--apply') {
      options.apply = true;
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

export async function runErpToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(ERP_USAGE);
    return { exitCode: options.command || options.help ? 0 : 1 };
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  try {
    switch (options.command) {
      case 'import-url': {
        if (!options.url) return fail('import-url requires --url');
        return await post(baseUrl, token, '/api/tools/erp/import-url', {
          url: options.url,
          ...(options.table ? { tableName: options.table } : {}),
          commit: !options.planOnly,
        });
      }
      case 'ask': {
        if (!options.text) return fail('ask requires --text');
        return await post(baseUrl, token, '/api/tools/erp/ask', {
          text: options.text,
          ...(options.table ? { tableRef: options.table } : {}),
          apply: options.apply,
        });
      }
      case 'pack': {
        if (!options.inputPath) return fail('pack requires --input with the pack spec JSON');
        const spec = await readInputJson(options.inputPath);
        return await post(baseUrl, token, '/api/tools/erp/pack', {
          spec,
          ...(options.slug ? { slug: options.slug } : {}),
        });
      }
      case 'pack-install': {
        if (!options.pack) return fail('pack-install requires --pack');
        return await post(baseUrl, token, '/api/tools/erp/pack-install', { pack: options.pack });
      }
      case 'preview': {
        if (!options.inputPath) return fail('preview requires --input with operations JSON');
        const body = await readInputJson(options.inputPath);
        return await post(baseUrl, token, '/api/tools/erp/preview', body);
      }
      case 'propose': {
        if (!options.inputPath) return fail('propose requires --input with {intent, operations}');
        const body = await readInputJson(options.inputPath);
        return await post(baseUrl, token, '/api/tools/erp/propose', body);
      }
      default:
        return fail(`unknown command: ${options.command}\n${ERP_USAGE}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
