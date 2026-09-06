import type { PageBlockType } from '@open-design/contracts';

export type PageMarkKind =
  | 'text'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'underline'
  | 'code'
  | 'link'
  | 'page';

export interface PageMark {
  kind: PageMarkKind;
  value: string;
  href?: string;
}

const TOKEN =
  /(`[^`]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|\[@[^\]]+\]\(page:[^)]+\)|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>"'`]+)/g;

/** Parse Notion-style markdown marks stored in a block's text. */
export function parsePageMarks(text: string): PageMark[] {
  if (!text) return [];
  const tokens: PageMark[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text))) {
    if (match.index > last) tokens.push({ kind: 'text', value: text.slice(last, match.index) });
    const raw = match[0];
    if (raw.startsWith('`')) tokens.push({ kind: 'code', value: raw.slice(1, -1) });
    else if (raw.startsWith('**')) tokens.push({ kind: 'bold', value: raw.slice(2, -2) });
    else if (raw.startsWith('__')) tokens.push({ kind: 'underline', value: raw.slice(2, -2) });
    else if (raw.startsWith('~~')) tokens.push({ kind: 'strike', value: raw.slice(2, -2) });
    else if (raw.startsWith('*')) tokens.push({ kind: 'italic', value: raw.slice(1, -1) });
    else if (raw.startsWith('[@')) {
      const inner = raw.slice(2, raw.indexOf(']'));
      const href = raw.slice(raw.indexOf('(page:') + 6, -1);
      tokens.push({ kind: 'page', value: inner, href });
    } else if (raw.startsWith('[')) {
      const label = raw.slice(1, raw.indexOf(']'));
      const href = raw.slice(raw.indexOf('(') + 1, -1);
      tokens.push({ kind: 'link', value: label, href });
    } else tokens.push({ kind: 'link', value: raw, href: raw });
    last = match.index + raw.length;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}

export function wrapPageMark(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
): string {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const selected = text.slice(from, to) || 'text';
  return `${text.slice(0, from)}${before}${selected}${after}${text.slice(to)}`;
}

export function insertPageMention(text: string, start: number, end: number, title: string, pageId: string): string {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const label = title.trim() || 'Untitled';
  return `${text.slice(0, from)}[@${label}](page:${pageId})${text.slice(to)}`;
}

const LATEX_UNICODE: Array<[RegExp, string]> = [
  [/\\times\b/g, '×'],
  [/\\cdot\b/g, '·'],
  [/\\pm\b/g, '±'],
  [/\\infty\b/g, '∞'],
  [/\\neq\b/g, '≠'],
  [/\\leq\b/g, '≤'],
  [/\\geq\b/g, '≥'],
  [/\\approx\b/g, '≈'],
  [/\\rightarrow\b/g, '→'],
  [/\\leftarrow\b/g, '←'],
  [/\\sum\b/g, '∑'],
  [/\\prod\b/g, '∏'],
  [/\\int\b/g, '∫'],
  [/\\sqrt\b/g, '√'],
  [/\\alpha\b/g, 'α'],
  [/\\beta\b/g, 'β'],
  [/\\gamma\b/g, 'γ'],
  [/\\delta\b/g, 'δ'],
  [/\\pi\b/g, 'π'],
  [/\\theta\b/g, 'θ'],
  [/\\lambda\b/g, 'λ'],
  [/\\mu\b/g, 'μ'],
  [/\\sigma\b/g, 'σ'],
  [/\\omega\b/g, 'ω'],
  [/\\mathbb\{R\}/g, 'ℝ'],
  [/\\mathbb\{N\}/g, 'ℕ'],
  [/\\mathbb\{Z\}/g, 'ℤ'],
];

/** Lightweight LaTeX → readable math for the equation block. */
export function latexToDisplay(src: string): string {
  let out = src.trim();
  if (!out) return '';
  out = out.replace(/^\$+|\$+$/g, '').trim();
  for (const [pattern, glyph] of LATEX_UNICODE) out = out.replace(pattern, glyph);
  out = out.replace(/\^\{([^}]+)\}/g, (_, inner: string) => toSuperscript(inner));
  out = out.replace(/\^([A-Za-z0-9+\-])/g, (_, inner: string) => toSuperscript(inner));
  out = out.replace(/_\{([^}]+)\}/g, (_, inner: string) => toSubscript(inner));
  out = out.replace(/_([A-Za-z0-9+\-])/g, (_, inner: string) => toSubscript(inner));
  out = out.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, (_, a: string, b: string) => `(${a})/(${b})`);
  out = out.replace(/[{}]/g, '');
  return out;
}

const SUPER: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  n: 'ⁿ',
  i: 'ⁱ',
};
const SUB: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  a: 'ₐ',
  e: 'ₑ',
  i: 'ᵢ',
  o: 'ₒ',
  n: 'ₙ',
  x: 'ₓ',
};

function toSuperscript(value: string): string {
  return [...value].map((ch) => SUPER[ch] ?? ch).join('');
}

function toSubscript(value: string): string {
  return [...value].map((ch) => SUB[ch] ?? ch).join('');
}

export const MEDIA_BLOCK_TYPES = new Set<PageBlockType>([
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'embed',
  'bookmark',
]);
