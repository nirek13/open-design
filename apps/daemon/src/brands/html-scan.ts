// Small HTML/CSS scanners shared by brand harvest. Sites disagree wildly on
// quoting, attribute order, srcset vs data-src, and theme-color markup — one
// parser keeps prefetch, logo-fallback, and seed-fallback honest about the
// same page.

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(Number.parseInt(n, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return '';
      }
    });
}

/** Read a tag attribute whether it is quoted, unquoted, or listed in any order. */
export function htmlAttr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[:.]/g, '\\$&');
  const quoted = new RegExp(`\\b${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (quoted) return decodeHtmlEntities(quoted[2] ?? quoted[3] ?? '');
  const unquoted = new RegExp(`\\b${escaped}\\s*=\\s*([^\\s"'=<>]+)`, 'i').exec(tag);
  if (unquoted) return decodeHtmlEntities(unquoted[1] ?? '');
  return undefined;
}

export function resolveHref(href: string | undefined | null, baseUrl: string): string | null {
  if (!href) return null;
  const raw = decodeHtmlEntities(href.trim());
  if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) return null;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

/** Highest-resolution URL from a `srcset` value (largest `w` or `x`). */
export function pickHighestSrcset(srcset: string): string | null {
  const entries = srcset
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const segments = part.split(/\s+/);
      const url = segments[0] ?? '';
      const descriptor = segments[1];
      let weight = 1;
      if (descriptor) {
        const w = /^(\d+)w$/.exec(descriptor);
        const x = /^([\d.]+)x$/.exec(descriptor);
        if (w) weight = Number(w[1]);
        else if (x) weight = Number(x[1]) * 1000;
      }
      return { url, weight };
    })
    .filter((e) => e.url && !e.url.startsWith('data:'));
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.weight - a.weight);
  return entries[0]?.url ?? null;
}

export interface ThemeColorHit {
  value: string;
  media?: string;
  source: 'theme-color' | 'msapplication-TileColor';
}

/** Every `theme-color` / Windows tile color on the page, including dark-scheme variants. */
export function extractThemeColors(html: string): ThemeColorHit[] {
  const out: ThemeColorHit[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (htmlAttr(tag, 'name') ?? htmlAttr(tag, 'property') ?? '').toLowerCase();
    const content = htmlAttr(tag, 'content');
    if (!content) continue;
    if (name === 'theme-color') {
      const media = htmlAttr(tag, 'media');
      out.push(media ? { value: content, media, source: 'theme-color' } : { value: content, source: 'theme-color' });
    } else if (name === 'msapplication-tilecolor') {
      out.push({ value: content, source: 'msapplication-TileColor' });
    }
  }
  return out;
}
