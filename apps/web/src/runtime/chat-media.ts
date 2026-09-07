// Helpers for team chat media: turn pasted URLs into embeddable links, map
// uploaded files onto a preview kind, and pull an accent from a signup
// design system so Slack can wear the company's colors.

export type ChatFileKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

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
  const mime = (mimeType ?? '').toLowerCase();
  const name = (fileName ?? '').toLowerCase();
  // Browsers cannot preview these image containers inline; treat them as files.
  if (mime === 'image/heic' || mime === 'image/heif' || /\.(heic|heif)$/i.test(name)) return 'file';
  if (mime.startsWith('image/') || /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(name)) return 'image';
  if (mime.startsWith('video/') || /\.(3gp|avi|m4v|mkv|mov|mp4|ogv|webm|wmv)$/i.test(name)) return 'video';
  if (mime.startsWith('audio/') || /\.(aac|flac|m4a|mp3|oga|ogg|wav|wma)$/i.test(name)) return 'audio';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  return 'file';
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
