import { htmlAttr, resolveHref } from './html-scan.js';

const SKIP_STYLESHEET_RE =
  /google-analytics|googletagmanager|hotjar|cookiebot|onetrust|segment\.com|newrelic|clarity\.ms/i;
const GOOGLE_FONTS_RE = /fonts\.googleapis\.com/i;
const PRINT_ONLY_RE = /^\s*print\s*$/i;

export interface StylesheetRef {
  url: string;
  googleFonts: boolean;
}

function isPrintOnly(media: string | undefined): boolean {
  if (!media) return false;
  return PRINT_ONLY_RE.test(media) && !/screen/i.test(media);
}

function pushStylesheet(
  href: string | undefined,
  baseUrl: string,
  out: StylesheetRef[],
  seen: Set<string>,
): void {
  const abs = resolveHref(href, baseUrl);
  if (!abs || seen.has(abs)) return;
  if (SKIP_STYLESHEET_RE.test(abs)) return;
  seen.add(abs);
  out.push({ url: abs, googleFonts: GOOGLE_FONTS_RE.test(abs) });
}

/**
 * Stylesheets the page actually wants painted: `rel=stylesheet`, preload-as-style,
 * and Google Fonts CSS links even when they hide behind `rel=preload` + onload.
 * Attribute order and quoting do not matter. Print-only sheets are skipped.
 */
export function findStylesheetRefs(html: string, baseUrl: string): StylesheetRef[] {
  const out: StylesheetRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const href = htmlAttr(tag, 'href');
    if (!href) continue;
    const rel = (htmlAttr(tag, 'rel') ?? '').toLowerCase();
    const as = (htmlAttr(tag, 'as') ?? '').toLowerCase();
    const media = htmlAttr(tag, 'media');
    if (isPrintOnly(media)) continue;
    const isSheet = /\bstylesheet\b/.test(rel);
    const isStylePreload = /\bpreload\b/.test(rel) && as === 'style';
    const isGoogleCss = GOOGLE_FONTS_RE.test(href) && /\/css2?(\?|$)/i.test(href);
    if (!isSheet && !isStylePreload && !isGoogleCss) continue;
    pushStylesheet(href, baseUrl, out, seen);
  }
  return out;
}

/** `@import` URLs inside already-fetched CSS, resolved against that file's URL. */
export function findCssImportUrls(css: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /@import\s+(?:url\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])/gi;
  for (const m of css.matchAll(re)) {
    const href = m[1] || m[2];
    const abs = resolveHref(href, baseUrl);
    if (!abs || seen.has(abs) || SKIP_STYLESHEET_RE.test(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
