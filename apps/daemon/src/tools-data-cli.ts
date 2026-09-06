// Agent-facing CLI wrapper for the Workspace Database tool endpoints.
// Invoked from agent runs as:
//   "$OD_NODE_BIN" "$OD_BIN" tools data <verb> ...
// Auth rides the per-run OD_TOOL_TOKEN bearer; the daemon derives workspace
// scope and actor attribution from the grant, never from arguments.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

const DATA_USAGE = `Usage:
  od tools data list-tables
  od tools data describe-table --table <name-or-id>
  od tools data create-table --input schema.json
  od tools data query --table <name-or-id> [--input query.json]
  od tools data insert --table <name-or-id> --input record.json
  od tools data update --table <name-or-id> --record <record-id> --input patch.json [--expected-revision <n>]
  od tools data import-url --url <https://...> [--table <name>] [--plan-only]

Input files:
  create-table  {"name":"employees","fields":[{"name":"email","type":"text","required":true,"unique":true}]}
  query         {"filters":[{"field":"level","op":"eq","value":"senior"}],"sort":{"field":"created_at","direction":"desc"},"limit":50}
  insert        {"full_name":"Ada","email":"ada@co.com"}      (the record's data object)
  update        {"salary":120000}                              (partial data patch; null clears a field)
  Pass --input - to read the JSON payload from stdin.

Magic import:
  Pulls a public Google Sheet, CSV, JSON, HTML table, open-data dump, or any
  public page (JS directories, Algolia catalogs, or AI-scraped prose) and
  creates a workspace table. Re-importing the same link updates matching unique
  keys instead of duplicating rows. Default commits. Pass --plan-only to preview.

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

interface ParsedDataOptions {
  command: string | undefined;
  table?: string;
  record?: string;
  inputPath?: string;
  url?: string;
  expectedRevision?: number;
  planOnly: boolean;
  help: boolean;
}

function parseOptions(args: string[]): ParsedDataOptions | { error: string } {
  const [command, ...rest] = args;
  const options: ParsedDataOptions = {
    command: command === '-h' || command === '--help' ? undefined : command,
    help: command === '-h' || command === '--help',
    planOnly: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--table') {
      const value = rest[++index];
      if (!value) return { error: '--table requires a table name or id' };
      options.table = value;
    } else if (arg === '--record') {
      const value = rest[++index];
      if (!value) return { error: '--record requires a record id' };
      options.record = value;
    } else if (arg === '--url') {
      const value = rest[++index];
      if (!value) return { error: '--url requires a link' };
      options.url = value;
    } else if (arg === '--input') {
      const value = rest[++index];
      if (!value) return { error: '--input requires a file path or -' };
      options.inputPath = value;
    } else if (arg === '--expected-revision') {
      const value = rest[++index];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1) return { error: '--expected-revision must be a positive integer' };
      options.expectedRevision = parsed;
    } else if (arg === '--plan-only') {
      options.planOnly = true;
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

export async function runDataToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(DATA_USAGE);
    return { exitCode: options.command || options.help ? 0 : 1 };
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  try {
    switch (options.command) {
      case 'list-tables':
        return await post(baseUrl, token, '/api/tools/data/list-tables', {});
      case 'describe-table': {
        if (!options.table) return fail('describe-table requires --table');
        return await post(baseUrl, token, '/api/tools/data/describe-table', { table: options.table });
      }
      case 'create-table': {
        if (!options.inputPath) return fail('create-table requires --input with the table schema JSON');
        const schema = await readInputJson(options.inputPath);
        return await post(baseUrl, token, '/api/tools/data/create-table', schema);
      }
      case 'query': {
        if (!options.table) return fail('query requires --table');
        const query = options.inputPath ? await readInputJson(options.inputPath) : {};
        return await post(baseUrl, token, '/api/tools/data/query', { ...query, table: options.table });
      }
      case 'insert': {
        if (!options.table) return fail('insert requires --table');
        if (!options.inputPath) return fail('insert requires --input with the record data JSON');
        const data = await readInputJson(options.inputPath);
        return await post(baseUrl, token, '/api/tools/data/insert', { table: options.table, data });
      }
      case 'update': {
        if (!options.table) return fail('update requires --table');
        if (!options.record) return fail('update requires --record');
        if (!options.inputPath) return fail('update requires --input with the partial data JSON');
        const data = await readInputJson(options.inputPath);
        return await post(baseUrl, token, '/api/tools/data/update', {
          table: options.table,
          recordId: options.record,
          data,
          ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
        });
      }
      case 'import-url': {
        if (!options.url) return fail('import-url requires --url');
        return await post(baseUrl, token, '/api/tools/data/import-url', {
          url: options.url,
          ...(options.table ? { tableName: options.table } : {}),
          commit: !options.planOnly,
        });
      }
      default:
        return fail(`unknown command: ${options.command}\n${DATA_USAGE}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
