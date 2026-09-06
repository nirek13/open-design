// Agent-facing CLI wrapper for organization team chat.
// Invoked from agent runs as:
//   "$OD_NODE_BIN" "$OD_BIN" tools team <verb> ...
// Auth rides the per-run OD_TOOL_TOKEN bearer.

type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

const TEAM_USAGE = `Usage:
  od tools team channels
  od tools team members [--channel <id-or-slug>]
  od tools team messages --channel <id-or-slug> [--limit <n>]
  od tools team dm --member <member-id>[,<member-id>]
  od tools team post --channel <id-or-slug> --body <text>

Same store as the messaging UI. Discover people with \`members\`, then DM or
post to a channel id or slug (#general). Do not print OD_TOOL_TOKEN.

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
  channel?: string;
  member?: string;
  body?: string;
  limit?: number;
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
    if (arg === '--channel') {
      const value = rest[++index];
      if (!value) return { error: '--channel requires a channel id or slug' };
      options.channel = value;
    } else if (arg === '--member') {
      const value = rest[++index];
      if (!value) return { error: '--member requires a member id' };
      options.member = value;
    } else if (arg === '--body') {
      const value = rest[++index];
      if (value === undefined) return { error: '--body requires text' };
      options.body = value;
    } else if (arg === '--limit') {
      const value = rest[++index];
      if (!value) return { error: '--limit requires a number' };
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return { error: '--limit must be a number' };
      options.limit = parsed;
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

export async function runTeamToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(TEAM_USAGE);
    return { exitCode: options.command || options.help ? 0 : 1 };
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  try {
    switch (options.command) {
      case 'channels':
        return await post(baseUrl, token, '/api/tools/team/channels', {});
      case 'members':
        return await post(baseUrl, token, '/api/tools/team/members', {
          ...(options.channel ? { channel: options.channel } : {}),
        });
      case 'messages': {
        if (!options.channel) return fail('messages requires --channel');
        return await post(baseUrl, token, '/api/tools/team/messages', {
          channel: options.channel,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        });
      }
      case 'dm': {
        if (!options.member) return fail('dm requires --member');
        return await post(baseUrl, token, '/api/tools/team/dm', { member: options.member });
      }
      case 'post': {
        if (!options.channel) return fail('post requires --channel');
        if (options.body === undefined) return fail('post requires --body');
        return await post(baseUrl, token, '/api/tools/team/post', {
          channel: options.channel,
          body: options.body,
        });
      }
      default:
        return fail(`unknown command: ${options.command}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
