// Agent-facing CLI wrapper for organization mail (live Gmail).
// Invoked from agent runs as:
//   "$OD_NODE_BIN" "$OD_BIN" tools mail <verb> ...
// Auth rides the per-run OD_TOOL_TOKEN bearer.

type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

const MAIL_USAGE = `Usage:
  od tools mail list [--query <text>] [--label <id>] [--max <n>]
  od tools mail get --thread <thread-id>
  od tools mail send --to <emails> --subject <text> --body <text>
  od tools mail reply --thread <thread-id> --body <text> [--to <emails>]
  od tools mail modify --message <message-id> [--add <labels>] [--remove <labels>]
  od tools mail triage [--apply] [--label <id>] [--query <text>] [--max <n>]
  od tools mail summarize --thread <thread-id>
  od tools mail draft --thread <thread-id> [--instruction <text>]

Same mailbox as the Mail UI. Gmail must already be connected under Integrations.
Triage stars mail that needs a reply, archives bulk, and marks FYI read.
Do not print OD_TOOL_TOKEN.

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

interface Options {
  command?: string;
  query?: string;
  label?: string;
  max?: number;
  thread?: string;
  to?: string;
  subject?: string;
  body?: string;
  message?: string;
  add?: string;
  remove?: string;
  instruction?: string;
  apply?: boolean;
  help?: boolean;
}

function parseOptions(args: string[]): Options | { error: string } {
  const options: Options = {};
  const rest = [...args];
  if (rest[0] && !rest[0].startsWith('-')) {
    const command = rest.shift();
    if (command) options.command = command;
  }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--query') {
      const value = rest[++index];
      if (value === undefined) return { error: '--query requires text' };
      options.query = value;
    } else if (arg === '--label') {
      const value = rest[++index];
      if (!value) return { error: '--label requires a label id' };
      options.label = value;
    } else if (arg === '--max') {
      const value = rest[++index];
      if (!value) return { error: '--max requires a number' };
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { error: '--max must be a number' };
      options.max = parsed;
    } else if (arg === '--thread') {
      const value = rest[++index];
      if (!value) return { error: '--thread requires a thread id' };
      options.thread = value;
    } else if (arg === '--to') {
      const value = rest[++index];
      if (!value) return { error: '--to requires at least one email' };
      options.to = value;
    } else if (arg === '--subject') {
      const value = rest[++index];
      if (value === undefined) return { error: '--subject requires text' };
      options.subject = value;
    } else if (arg === '--body') {
      const value = rest[++index];
      if (value === undefined) return { error: '--body requires text' };
      options.body = value;
    } else if (arg === '--message') {
      const value = rest[++index];
      if (!value) return { error: '--message requires a message id' };
      options.message = value;
    } else if (arg === '--add') {
      const value = rest[++index];
      if (value === undefined) return { error: '--add requires label ids' };
      options.add = value;
    } else if (arg === '--remove') {
      const value = rest[++index];
      if (value === undefined) return { error: '--remove requires label ids' };
      options.remove = value;
    } else if (arg === '--instruction') {
      const value = rest[++index];
      if (value === undefined) return { error: '--instruction requires text' };
      options.instruction = value;
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

export async function runMailToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(MAIL_USAGE);
    return { exitCode: options.command || options.help ? 0 : 1 };
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  try {
    switch (options.command) {
      case 'list':
        return await post(baseUrl, token, '/api/tools/mail/list', {
          ...(options.query ? { query: options.query } : {}),
          ...(options.label ? { label: options.label } : {}),
          ...(options.max === undefined ? {} : { maxResults: options.max }),
        });
      case 'get': {
        if (!options.thread) return fail('get requires --thread');
        return await post(baseUrl, token, '/api/tools/mail/get', { threadId: options.thread });
      }
      case 'send': {
        if (!options.to) return fail('send requires --to');
        if (options.subject === undefined) return fail('send requires --subject');
        if (options.body === undefined) return fail('send requires --body');
        return await post(baseUrl, token, '/api/tools/mail/send', {
          to: options.to,
          subject: options.subject,
          body: options.body,
        });
      }
      case 'reply': {
        if (!options.thread) return fail('reply requires --thread');
        if (options.body === undefined) return fail('reply requires --body');
        return await post(baseUrl, token, '/api/tools/mail/reply', {
          threadId: options.thread,
          body: options.body,
          ...(options.to ? { to: options.to } : {}),
        });
      }
      case 'modify': {
        if (!options.message) return fail('modify requires --message');
        if (!options.add && !options.remove) return fail('modify requires --add or --remove');
        return await post(baseUrl, token, '/api/tools/mail/modify', {
          messageId: options.message,
          ...(options.add ? { add: options.add } : {}),
          ...(options.remove ? { remove: options.remove } : {}),
        });
      }
      case 'triage':
        return await post(baseUrl, token, '/api/tools/mail/triage', {
          apply: options.apply === true,
          ...(options.query ? { query: options.query } : {}),
          ...(options.label ? { label: options.label } : {}),
          ...(options.max === undefined ? {} : { maxResults: options.max }),
        });
      case 'summarize': {
        if (!options.thread) return fail('summarize requires --thread');
        return await post(baseUrl, token, '/api/tools/mail/summarize', { threadId: options.thread });
      }
      case 'draft': {
        if (!options.thread) return fail('draft requires --thread');
        return await post(baseUrl, token, '/api/tools/mail/draft', {
          threadId: options.thread,
          ...(options.instruction ? { instruction: options.instruction } : {}),
        });
      }
      default:
        return fail(`unknown command: ${options.command}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
