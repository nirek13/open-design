// Helpers for team chat media: turn pasted URLs into embeddable links, map
// uploaded files onto a preview kind, and pull an accent from a signup
// design system so Slack can wear the company's colors.

export type ChatFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'json'
  | 'code'
  | 'text'
  | 'font'
  | 'file';

/** Cap inline text previews so a 20 MB log does not freeze the composer. */
export const CHAT_TEXT_PREVIEW_MAX_BYTES = 400_000;

const CODE_EXT =
  /\.(bash|c|cc|cjs|cpp|cs|css|dart|diff|go|graphql|h|hpp|java|js|jsonc|jsx|kt|kts|lua|mjs|patch|php|ps1|py|r|rb|rs|scala|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|yaml|yml|zig|zsh)$/i;
const TEXT_EXT = /\.(cfg|conf|env|ics|ini|log|rtf|txt|vcf|vcard)$/i;

export interface ChatAccent {
  sidebar: string;
  sidebarHover: string;
  active: string;
  accent: string;
  onAccent: string;
  avatar: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const TOKEN_RE =
  /--(?:color-)?(?:primary|accent|brand|brand-primary|od-color-primary)[^:]*:\s*(#[0-9a-fA-F]{3,8})/gi;

export const DEFAULT_CHAT_ACCENT: ChatAccent = {
  sidebar: '#3f0e40',
  sidebarHover: 'rgba(255, 255, 255, 0.1)',
  active: '#1164a3',
  accent: '#1164a3',
  onAccent: '#ffffff',
  avatar: '#611f69',
};

export function extractMessageUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;!?]+$/u, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.slice(0, 8);
}

export function splitMessageText(
  text: string,
): Array<{ type: 'text' | 'url'; value: string }> {
  if (!text) return [];
  const parts: Array<{ type: 'text' | 'url'; value: string }> = [];
  const re = new RegExp(URL_RE.source, 'gi');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = match[0];
    const cleaned = raw.replace(/[),.;!?]+$/u, '');
    const start = match.index;
    if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
    parts.push({ type: 'url', value: cleaned });
    if (cleaned.length < raw.length) {
      parts.push({ type: 'text', value: raw.slice(cleaned.length) });
    }
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

export function chatFileKind(mimeType?: string, fileName?: string): ChatFileKind {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0]!.trim();
  const name = (fileName ?? '').toLowerCase();
  // Browsers cannot preview these image containers inline; treat them as files.
  if (mime === 'image/heic' || mime === 'image/heif' || /\.(heic|heif)$/i.test(name)) return 'file';
  if (mime.startsWith('image/') || /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(name)) return 'image';
  if (mime.startsWith('video/') || /\.(3gp|avi|m4v|mkv|mov|mp4|ogv|webm|wmv)$/i.test(name)) return 'video';
  if (mime.startsWith('audio/') || /\.(aac|flac|m4a|mp3|oga|ogg|wav|wma)$/i.test(name)) return 'audio';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime === 'text/markdown' || mime === 'text/x-markdown' || /\.mdx?$/i.test(name)) return 'markdown';
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || /\.(html?|xhtml)$/i.test(name)) {
    return 'html';
  }
  if (mime === 'text/csv' || mime === 'text/tab-separated-values' || /\.(csv|tsv)$/i.test(name)) {
    return 'csv';
  }
  if (
    mime === 'application/json'
    || mime === 'application/jsonl'
    || mime === 'text/json'
    || /\.(json|jsonl|ndjson)$/i.test(name)
  ) {
    return 'json';
  }
  if (
    mime.startsWith('font/')
    || mime === 'application/font-woff'
    || mime === 'application/font-woff2'
    || mime === 'application/x-font-ttf'
    || /\.(woff2?|ttf|otf)$/i.test(name)
  ) {
    return 'font';
  }
  if (
    mime === 'text/css'
    || mime === 'text/javascript'
    || mime === 'application/javascript'
    || mime === 'application/x-javascript'
    || mime === 'application/typescript'
    || mime.startsWith('text/x-')
    || CODE_EXT.test(name)
  ) {
    return 'code';
  }
  if (mime.startsWith('text/') || TEXT_EXT.test(name)) return 'text';
  return 'file';
}

export function chatFileNeedsText(kind: ChatFileKind): boolean {
  return kind === 'markdown'
    || kind === 'html'
    || kind === 'csv'
    || kind === 'json'
    || kind === 'code'
    || kind === 'text';
}

export async function readChatPreviewText(input: {
  url: string;
  byteSize?: number;
  file?: File;
}): Promise<{ text: string; truncated: boolean }> {
  const max = CHAT_TEXT_PREVIEW_MAX_BYTES;
  if (input.file) {
    const truncated = input.file.size > max;
    const text = await input.file.slice(0, max).text();
    return { text, truncated };
  }
  if (typeof input.byteSize === 'number' && input.byteSize > 2 * 1024 * 1024) {
    throw new Error('too large');
  }
  const res = await fetch(input.url);
  if (!res.ok) throw new Error('preview failed');
  const text = await res.text();
  if (text.length > max) return { text: text.slice(0, max), truncated: true };
  return { text, truncated: false };
}

/** Split a CSV/TSV blob into rows for the built-in table preview. */
export function parseChatCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const pushCell = () => {
    row.push(cell);
    cell = '';
  };
  const pushRow = () => {
    rows.push(row.slice(0, 40));
    row = [];
  };
  for (let i = 0; i < text.length && rows.length < 200; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      continue;
    }
    if (ch === '\n') {
      pushCell();
      pushRow();
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    pushCell();
    pushRow();
  }
  return rows;
}

/** Collect files from a drag, drop, or paste. Prefer `files` when the browser
 * filled it; otherwise walk `items` so a screenshot paste still attaches. */
export function filesFromTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files ?? []);
  if (fromFiles.length > 0) return fromFiles;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export function formatChatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeHex(value: string): string | null {
  const hex = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function parseRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function isLight(hex: string): boolean {
  const { r, g, b } = parseRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
}

function readableOn(hex: string): string {
  return isLight(hex) ? '#1a1916' : '#ffffff';
}

function darken(hex: string, amount: number): string {
  const { r, g, b } = parseRgb(hex);
  const mix = (channel: number) => Math.round(channel * (1 - amount));
  return `#${[mix(r), mix(g), mix(b)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function collectHexes(css: string, swatches: string[]): string[] {
  const fromTokens: string[] = [];
  for (const match of css.matchAll(TOKEN_RE)) {
    const hex = normalizeHex(match[1] ?? '');
    if (hex) fromTokens.push(hex);
  }
  const loose = [...(css.match(HEX_RE) ?? []), ...swatches]
    .map((value) => normalizeHex(value))
    .filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hex of [...fromTokens, ...loose]) {
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

export function parseChatAccent(css: string, swatches: string[] = []): ChatAccent | null {
  const hexes = collectHexes(css, swatches);
  if (hexes.length === 0) return null;
  const accent = hexes[0]!;
  const dark = hexes.find((hex) => !isLight(hex));
  const sidebar = dark ?? darken(accent, isLight(accent) ? 0.62 : 0.18);
  const active = hexes[1] && hexes[1] !== sidebar ? hexes[1] : accent;
  return {
    sidebar,
    sidebarHover: 'rgba(255, 255, 255, 0.1)',
    active,
    accent,
    onAccent: readableOn(accent),
    avatar: darken(accent, isLight(accent) ? 0.28 : 0.08),
  };
}

export function chatAccentCssVars(accent: ChatAccent): Record<string, string> {
  return {
    '--chat-sidebar': accent.sidebar,
    '--chat-sidebar-hover': accent.sidebarHover,
    '--chat-active': accent.active,
    '--chat-accent': accent.accent,
    '--chat-on-accent': accent.onAccent,
    '--chat-avatar': accent.avatar,
  };
}
