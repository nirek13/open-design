// Slack-style message formatting: *bold*, _italic_, ~strike~, `code`,
// fenced blocks, quotes, and @mentions. Kept small so the transcript can
// render without pulling a markdown library into the web bundle.

export type ChatInlineKind = 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'url' | 'mention';

export interface ChatInline {
  kind: ChatInlineKind;
  value: string;
}

export interface ChatBlock {
  kind: 'p' | 'quote' | 'code' | 'list';
  text: string;
  items?: string[];
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

export function parseChatBlocks(body: string): ChatBlock[] {
  if (!body) return [];
  const blocks: ChatBlock[] = [];
  const lines = body.split('\n');
  let quote: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  let fence: string[] | null = null;
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      quote = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ kind: 'list', text: '', items: [...list] });
      list = [];
    }
  };
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join('\n') });
      para = [];
    }
  };
  for (const line of lines) {
    if (fence) {
      if (line.startsWith('```')) {
        blocks.push({ kind: 'code', text: fence.join('\n') });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.startsWith('```')) {
      flushQuote();
      flushList();
      flushPara();
      fence = [];
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushList();
      flushPara();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushQuote();
      flushPara();
      list.push(line.replace(/^[-*]\s+/, ''));
      continue;
    }
    flushQuote();
    flushList();
    para.push(line);
  }
  if (fence) blocks.push({ kind: 'code', text: fence.join('\n') });
  flushQuote();
  flushList();
  flushPara();
  return blocks.length > 0 ? blocks : [{ kind: 'p', text: body }];
}

export function parseChatInline(text: string): ChatInline[] {
  if (!text) return [];
  const tokens: ChatInline[] = [];
  const pattern =
    /(`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s<>"'`]+|@[A-Za-z0-9._-]{1,32})/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) tokens.push({ kind: 'text', value: text.slice(last, match.index) });
    const raw = match[0];
    if (raw.startsWith('`')) tokens.push({ kind: 'code', value: raw.slice(1, -1) });
    else if (raw.startsWith('*')) tokens.push({ kind: 'bold', value: raw.slice(1, -1) });
    else if (raw.startsWith('_')) tokens.push({ kind: 'italic', value: raw.slice(1, -1) });
    else if (raw.startsWith('~')) tokens.push({ kind: 'strike', value: raw.slice(1, -1) });
    else if (raw.startsWith('http')) {
      tokens.push({ kind: 'url', value: raw.replace(/[),.;!?]+$/u, '') });
    } else tokens.push({ kind: 'mention', value: raw });
    last = match.index + raw.length;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}

export function wrapSelection(text: string, start: number, end: number, mark: string): string {
  const inner = text.slice(start, end) || 'text';
  return `${text.slice(0, start)}${mark}${inner}${mark}${text.slice(end)}`;
}

export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((match) => match[0].replace(/[),.;!?]+$/u, ''));
}

export type SlashName =
  | 'shrug'
  | 'me'
  | 'topic'
  | 'purpose'
  | 'mute'
  | 'unmute'
  | 'leave'
  | 'invite'
  | 'remind'
  | 'status'
  | 'archive'
  | 'unarchive'
  | 'join'
  | 'who'
  | 'away'
  | 'dnd'
  | 'msg'
  | 'help';

export type SlashCommand = { name: SlashName; rest: string };

const SLASH_NAMES = new Set<SlashName>([
  'shrug', 'me', 'topic', 'purpose', 'mute', 'unmute', 'leave', 'invite',
  'remind', 'status', 'archive', 'unarchive', 'join', 'who', 'away', 'dnd',
  'msg', 'help',
]);

export function parseSlashCommand(text: string): SlashCommand | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (!SLASH_NAMES.has(name as SlashName)) return null;
  return { name: name as SlashName, rest: (match[2] ?? '').trim() };
}

export const SLASH_HELP = [
  '/shrug — append ¯\\_(ツ)_/¯',
  '/me — italicize as an action',
  '/topic — set the channel topic',
  '/purpose — set the channel description',
  '/mute /unmute — mute this channel',
  '/leave /join /archive /unarchive',
  '/invite @name — add someone',
  '/msg @name — open a DM',
  '/remind 20m|1h|tomorrow — remind yourself about the latest message',
  '/status [text] — set or clear your status',
  '/away /dnd — pause notifications',
  '/who — open the member list',
].join('\n');

export function chatTomorrowMorning(now = Date.now()): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

export function chatWhen(kind: '20m' | '1h' | 'tomorrow', now = Date.now()): number {
  if (kind === '20m') return now + 20 * 60_000;
  if (kind === '1h') return now + 60 * 60_000;
  return chatTomorrowMorning(now);
}

export function parseRemindWhen(raw: string, now = Date.now()): number | null {
  const text = raw.trim().toLowerCase();
  if (!text || text === '20m' || text === '20') return chatWhen('20m', now);
  if (text === '1h' || text === '1' || text === 'hour') return chatWhen('1h', now);
  if (text === 'tomorrow' || text === 'tmr') return chatWhen('tomorrow', now);
  return null;
}
