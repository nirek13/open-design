import { htmlAttr, pickHighestSrcset, resolveHref } from './html-scan.js';

export type DiscoveredLogoKind =
  | 'apple-touch-icon'
  | 'favicon'
  | 'mask-icon'
  | 'og-image'
  | 'header-img'
  | 'manifest-icon'
  | 'json-ld'
  | 'well-known'
  | 'tile-image';

export interface DiscoveredLogo {
  url: string;
  kind: DiscoveredLogoKind;
  /** Lower is a stronger primary candidate. */
  rank: number;
}

const KIND_RANK: Record<DiscoveredLogoKind, number> = {
  'apple-touch-icon': 0,
  'manifest-icon': 0,
  'json-ld': 1,
  'header-img': 2,
  'mask-icon': 3,
  favicon: 4,
  'tile-image': 4,
  'well-known': 5,
  'og-image': 6,
};

function headerScopes(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<header\b[\s\S]{0,16000}?<\/header>/gi)) parts.push(m[0]);
  for (const m of html.matchAll(/<nav\b[\s\S]{0,16000}?<\/nav>/gi)) parts.push(m[0]);
  return parts.join('\n');
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SVG_RE = /<svg\b[\s\S]{0,24000}?<\/svg>/gi;
const LOGO_HINT_RE = /logo|wordmark|brand|lockup|masthead|logotype/i;
const ICON_CHROME_RE = /\b(hamburger|menu-icon|icon-menu|nav-toggle|search-icon|chevron|caret|close-icon)\b/i;
const TINY_VIEWBOX_RE = /viewBox=["']\s*0\s+0\s+(1[2-9]|2[0-4])\s+(1[2-9]|2[0-4])\s*["']/i;
const JSON_LD_RE =
  /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]{0,200000}?)<\/script>/gi;
const ORG_TYPE_RE = /organization|website|brand|corporation|store|localbusiness/i;

const WELL_KNOWN_PATHS: Array<{ path: string; kind: DiscoveredLogoKind }> = [
  { path: '/apple-touch-icon.png', kind: 'apple-touch-icon' },
  { path: '/apple-touch-icon-precomposed.png', kind: 'apple-touch-icon' },
  { path: '/favicon.svg', kind: 'favicon' },
  { path: '/logo.svg', kind: 'well-known' },
  { path: '/logo.png', kind: 'well-known' },
  { path: '/images/logo.svg', kind: 'well-known' },
  { path: '/assets/logo.svg', kind: 'well-known' },
  { path: '/static/logo.svg', kind: 'well-known' },
];

function pushLogo(
  refs: DiscoveredLogo[],
  seen: Set<string>,
  href: string | undefined | null,
  baseUrl: string,
  kind: DiscoveredLogoKind,
): void {
  const abs = resolveHref(href, baseUrl);
  if (!abs || seen.has(abs)) return;
  seen.add(abs);
  refs.push({ url: abs, kind, rank: KIND_RANK[kind] });
}

function imgHref(tag: string): string | undefined {
  return (
    pickHighestSrcset(htmlAttr(tag, 'srcset') ?? '') ||
    htmlAttr(tag, 'src') ||
    pickHighestSrcset(htmlAttr(tag, 'data-srcset') ?? '') ||
    htmlAttr(tag, 'data-src') ||
    htmlAttr(tag, 'data-lazy-src') ||
    undefined
  );
}

function looksLikeLogoTag(tag: string): boolean {
  return LOGO_HINT_RE.test(tag) || /itemprop\s*=\s*["']?logo["']?/i.test(tag);
}

function svgLooksLikeChrome(svg: string): boolean {
  if (LOGO_HINT_RE.test(svg)) return false;
  if (ICON_CHROME_RE.test(svg)) return true;
  return TINY_VIEWBOX_RE.test(svg) && svg.length < 500;
}

function normalizeSvg(svg: string): string {
  return svg.includes('xmlns')
    ? svg
    : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

function jsonLdLogoUrls(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) jsonLdLogoUrls(child, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj['@graph']) jsonLdLogoUrls(obj['@graph'], out, depth + 1);
  const typeRaw = obj['@type'];
  const type = Array.isArray(typeRaw) ? typeRaw.join(',') : String(typeRaw ?? '');
  if (ORG_TYPE_RE.test(type)) {
    const logo = obj.logo;
    if (typeof logo === 'string') out.push(logo);
    else if (logo && typeof logo === 'object') {
      const rec = logo as Record<string, unknown>;
      if (typeof rec.url === 'string') out.push(rec.url);
      if (typeof rec.contentUrl === 'string') out.push(rec.contentUrl);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'logo' || key === '@context' || key === '@graph') continue;
    if (typeof value === 'object') jsonLdLogoUrls(value, out, depth + 1);
  }
}

function collectJsonLdLogos(html: string, baseUrl: string, refs: DiscoveredLogo[], seen: Set<string>): void {
  for (const m of html.matchAll(JSON_LD_RE)) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const urls: string[] = [];
      jsonLdLogoUrls(parsed, urls);
      for (const url of urls) pushLogo(refs, seen, url, baseUrl, 'json-ld');
    } catch {
      /* invalid JSON-LD — skip */
    }
  }
}

function iconKindFromRel(rel: string): DiscoveredLogoKind | null {
  const tokens = rel.toLowerCase().split(/\s+/);
  if (tokens.some((t) => t === 'apple-touch-icon' || t === 'apple-touch-icon-precomposed')) {
    return 'apple-touch-icon';
  }
  if (tokens.some((t) => t === 'mask-icon')) return 'mask-icon';
  if (tokens.some((t) => t === 'icon' || t === 'shortcut' || t === 'shortcut-icon')) {
    return 'favicon';
  }
  if (/\bicon\b/.test(rel) && !/\bmask-icon\b/.test(rel)) return 'favicon';
  return null;
}

/**
 * Discover logo/icon URLs from page HTML. Pure — no I/O — so tests stay offline.
 * Covers icons (any attr order/quoting), apple-touch, mask-icon, JSON-LD Organization.logo,
 * itemprop=logo, header/nav images including srcset/lazy, og/twitter images, and Windows tiles.
 */
export function discoverLogoRefs(html: string, baseUrl: string): DiscoveredLogo[] {
  const refs: DiscoveredLogo[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = htmlAttr(tag, 'rel') ?? '';
    const href = htmlAttr(tag, 'href');
    const kind = iconKindFromRel(rel);
    if (kind) pushLogo(refs, seen, href, baseUrl, kind);
  }

  collectJsonLdLogos(html, baseUrl, refs, seen);

  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (htmlAttr(tag, 'name') ?? htmlAttr(tag, 'property') ?? '').toLowerCase();
    const content = htmlAttr(tag, 'content');
    if (!content) continue;
    if (name === 'og:image' || name === 'twitter:image' || name === 'twitter:image:src') {
      pushLogo(refs, seen, content, baseUrl, 'og-image');
    } else if (name === 'og:logo') {
      pushLogo(refs, seen, content, baseUrl, 'header-img');
    } else if (name === 'msapplication-tileimage') {
      pushLogo(refs, seen, content, baseUrl, 'tile-image');
    }
  }

  for (const m of html.matchAll(/<(?:link|meta|img)\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/itemprop\s*=\s*["']?logo["']?/i.test(tag)) continue;
    pushLogo(
      refs,
      seen,
      htmlAttr(tag, 'href') || htmlAttr(tag, 'content') || imgHref(tag),
      baseUrl,
      'header-img',
    );
  }

  const headerHtml = headerScopes(html);
  const scan = headerHtml ? headerHtml + html : html;
  for (const m of scan.matchAll(IMG_TAG_RE)) {
    const tag = m[0];
    const href = imgHref(tag);
    if (!href) continue;
    const inHeader = headerHtml.includes(tag);
    if (inHeader || looksLikeLogoTag(tag)) pushLogo(refs, seen, href, baseUrl, 'header-img');
  }

  if (headerHtml) {
    for (const m of headerHtml.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)) {
      const href = m[1];
      if (href && /\.(svg|png|webp|jpe?g)(?:[?#]|$)/i.test(href)) {
        pushLogo(refs, seen, href, baseUrl, 'header-img');
      }
    }
  }

  refs.sort((a, b) => a.rank - b.rank);
  return refs;
}

export function findManifestHref(html: string, baseUrl: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (htmlAttr(tag, 'rel') ?? '').toLowerCase();
    if (!/\bmanifest\b/.test(rel)) continue;
    return resolveHref(htmlAttr(tag, 'href'), baseUrl);
  }
  return null;
}

/** Icon URLs from a web-app manifest, largest `sizes` first. */
export function parseManifestIcons(json: string, manifestUrl: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const icons = (data as { icons?: unknown }).icons;
  if (!Array.isArray(icons)) return [];
  const ranked = icons
    .map((icon) => {
      if (!icon || typeof icon !== 'object') return null;
      const rec = icon as { src?: unknown; sizes?: unknown };
      if (typeof rec.src !== 'string') return null;
      const abs = resolveHref(rec.src, manifestUrl);
      if (!abs) return null;
      const sizes = typeof rec.sizes === 'string' ? rec.sizes : '';
      const dim = /(\d+)\s*x\s*(\d+)/i.exec(sizes);
      const area = dim ? Number(dim[1]) * Number(dim[2]) : 0;
      return { url: abs, area };
    })
    .filter((x): x is { url: string; area: number } => x !== null)
    .sort((a, b) => b.area - a.area);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const icon of ranked) {
    if (seen.has(icon.url)) continue;
    seen.add(icon.url);
    out.push(icon.url);
  }
  return out;
}

/** Conventional origin paths to try when the HTML harvest is thin. */
export function wellKnownLogoRefs(baseUrl: string): DiscoveredLogo[] {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }
  return WELL_KNOWN_PATHS.map(({ path, kind }) => ({
    url: `${origin}${path}`,
    kind,
    rank: KIND_RANK[kind],
  }));
}

/**
 * Inline SVGs that look like a wordmark: logo-classed marks first, then the
 * first substantial SVG in header/nav, skipping 24px menu glyphs.
 */
export function extractInlineLogoSvgs(html: string): string[] {
  const header = headerScopes(html) || html.slice(0, 40_000);
  const svgs: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw || raw.length < 80) return;
    if (svgLooksLikeChrome(raw)) return;
    const svg = normalizeSvg(raw);
    if (seen.has(svg)) return;
    seen.add(svg);
    svgs.push(svg);
  };

  const classified: string[] = [];
  const rest: string[] = [];
  for (const m of header.matchAll(SVG_RE)) {
    const svg = m[0];
    if (LOGO_HINT_RE.test(svg)) classified.push(svg);
    else rest.push(svg);
  }
  for (const svg of classified) push(svg);
  for (const svg of rest) {
    if (svgs.length >= 3) break;
    push(svg);
  }
  return svgs.slice(0, 3);
}

/** First harvested inline SVG (kept for existing call sites). */
export function extractInlineHeaderSvg(html: string): string | null {
  return extractInlineLogoSvgs(html)[0] ?? null;
}

/** Map discovery kinds onto the harvest's on-disk logo kinds. */
export function toHarvestLogoKind(
  kind: DiscoveredLogoKind,
): 'favicon' | 'apple-touch-icon' | 'og-image' | 'header-img' {
  if (kind === 'apple-touch-icon' || kind === 'manifest-icon' || kind === 'tile-image') {
    return 'apple-touch-icon';
  }
  if (kind === 'og-image') return 'og-image';
  if (kind === 'header-img' || kind === 'json-ld') return 'header-img';
  return 'favicon';
}
