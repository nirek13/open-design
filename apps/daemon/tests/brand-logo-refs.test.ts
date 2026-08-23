import { describe, expect, it } from 'vitest';

import { findCssImportUrls, findStylesheetRefs } from '../src/brands/css-links.js';
import { extractThemeColors } from '../src/brands/html-scan.js';
import {
  discoverLogoRefs,
  extractInlineLogoSvgs,
  findManifestHref,
  parseManifestIcons,
  wellKnownLogoRefs,
} from '../src/brands/logo-refs.js';
import { extractColors, normalizeColor } from '../src/brands/prefetch.js';

describe('discoverLogoRefs', () => {
  it('finds unquoted and reversed <link rel=icon> tags', () => {
    const html = [
      '<link rel=icon href=/favicon.ico>',
      '<link href="/icon-32.png" rel="icon" sizes="32x32">',
      '<link rel="apple-touch-icon-precomposed" href=/apple-touch-icon.png>',
      '<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#111">',
    ].join('');

    const refs = discoverLogoRefs(html, 'https://acme.test/app');
    const urls = refs.map((r) => r.url);

    expect(urls).toContain('https://acme.test/favicon.ico');
    expect(urls).toContain('https://acme.test/icon-32.png');
    expect(urls).toContain('https://acme.test/apple-touch-icon.png');
    expect(urls).toContain('https://acme.test/safari-pinned-tab.svg');
    expect(refs.find((r) => r.url.endsWith('/apple-touch-icon.png'))?.kind).toBe('apple-touch-icon');
    expect(refs.find((r) => r.url.endsWith('safari-pinned-tab.svg'))?.kind).toBe('mask-icon');
  });

  it('reads Organization.logo from JSON-LD, including ImageObject', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          name: 'Acme',
          logo: { '@type': 'ImageObject', url: 'https://cdn.acme.test/mark.svg' },
        },
      ],
    })}</script>`;

    const refs = discoverLogoRefs(html, 'https://acme.test/');
    expect(refs.some((r) => r.url === 'https://cdn.acme.test/mark.svg' && r.kind === 'json-ld')).toBe(
      true,
    );
  });

  it('picks srcset / data-src wordmarks and itemprop=logo', () => {
    const html = [
      '<header>',
      '<img class="Logo" data-src="/lazy-logo.svg" alt="Acme">',
      '<img src="/tiny.png" srcset="/logo-1x.png 1x, /logo-3x.png 3x" alt="">',
      '<img itemprop="logo" src="/schema-logo.png">',
      '</header>',
    ].join('');

    const urls = discoverLogoRefs(html, 'https://acme.test/').map((r) => r.url);
    expect(urls).toContain('https://acme.test/lazy-logo.svg');
    expect(urls).toContain('https://acme.test/logo-3x.png');
    expect(urls).toContain('https://acme.test/schema-logo.png');
  });

  it('reads og:logo and Windows tile image metas', () => {
    const html = [
      '<meta property="og:logo" content="https://cdn.acme.test/og-logo.png">',
      '<meta name="msapplication-TileImage" content="/mstile.png">',
    ].join('');
    const urls = discoverLogoRefs(html, 'https://acme.test/').map((r) => r.url);
    expect(urls).toContain('https://cdn.acme.test/og-logo.png');
    expect(urls).toContain('https://acme.test/mstile.png');
  });
});

describe('extractInlineLogoSvgs', () => {
  const logoSvg =
    '<svg class="logo" viewBox="0 0 120 40" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 H118 V38 H2 Z M10 10 H110 V30 H10 Z"/></svg>';
  const menuSvg = '<svg viewBox="0 0 24 24" class="menu-icon"><path d="M4 6h16M4 12h16"/></svg>';

  it('skips a 24px menu glyph and still keeps the class=logo wordmark', () => {
    const html = `<header>${menuSvg}${logoSvg}</header>`;
    const svgs = extractInlineLogoSvgs(html);
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    expect(svgs.some((s) => /class="logo"/.test(s))).toBe(true);
    expect(svgs.some((s) => /menu-icon/.test(s))).toBe(false);
  });
});

describe('manifest + well-known logo paths', () => {
  it('parses web app manifest icons largest-first', () => {
    const urls = parseManifestIcons(
      JSON.stringify({
        icons: [
          { src: '/icon-192.png', sizes: '192x192' },
          { src: '/icon-512.png', sizes: '512x512' },
          { src: 'https://cdn.acme.test/maskable.png', sizes: '512x512', purpose: 'maskable' },
        ],
      }),
      'https://acme.test/site.webmanifest',
    );
    expect(urls[0]).toBe('https://acme.test/icon-512.png');
    expect(urls).toContain('https://cdn.acme.test/maskable.png');
  });

  it('finds the manifest href regardless of attribute order', () => {
    expect(
      findManifestHref('<link href="/site.webmanifest" rel="manifest">', 'https://acme.test/'),
    ).toBe('https://acme.test/site.webmanifest');
  });

  it('lists conventional origin logo paths', () => {
    const urls = wellKnownLogoRefs('https://acme.test/docs').map((r) => r.url);
    expect(urls).toContain('https://acme.test/logo.svg');
    expect(urls).toContain('https://acme.test/apple-touch-icon.png');
  });
});

describe('theme colors + oklch', () => {
  it('reads light and dark theme-color metas without requiring quotes', () => {
    const html = [
      '<meta name=theme-color content=#e3120b>',
      '<meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)">',
      '<meta name="msapplication-TileColor" content="#e3120b">',
    ].join('');
    const hits = extractThemeColors(html);
    expect(hits.map((h) => h.value)).toEqual(expect.arrayContaining(['#e3120b', '#111111']));
    expect(hits.some((h) => h.media?.includes('dark'))).toBe(true);
  });

  it('normalizes oklch() literals to hex so modern CSS palettes rank as colors', () => {
    const red = normalizeColor('oklch(0.63 0.26 29)');
    expect(red).toMatch(/^#[0-9a-f]{6}$/);
    expect(parseInt(red!.slice(1, 3), 16)).toBeGreaterThan(parseInt(red!.slice(3, 5), 16));

    const white = normalizeColor('oklch(100% 0 0)');
    expect(white).toBe('#ffffff');

    const black = normalizeColor('oklch(0 0 0)');
    expect(black).toBe('#000000');

    const colors = extractColors(':root{--brand:oklch(0.7 0.18 30);--ink:#111111}');
    expect(colors.some((c) => c.hex.startsWith('#') && c.hex !== '#111111')).toBe(true);
  });
});

describe('findStylesheetRefs', () => {
  it('finds unquoted stylesheets, preload-as-style, and Google Fonts CSS', () => {
    const html = [
      '<link rel=stylesheet href=/app.css>',
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700" rel="preload" as="style">',
      '<link rel="stylesheet" href="/print.css" media="print">',
      '<link rel="stylesheet" href="https://www.googletagmanager.com/gtm.css">',
    ].join('');
    const refs = findStylesheetRefs(html, 'https://acme.test/');
    expect(refs.map((r) => r.url)).toContain('https://acme.test/app.css');
    expect(refs.some((r) => r.googleFonts && r.url.includes('fonts.googleapis.com'))).toBe(true);
    expect(refs.some((r) => r.url.includes('print.css'))).toBe(false);
    expect(refs.some((r) => r.url.includes('googletagmanager'))).toBe(false);
  });

  it('follows @import url() from harvested CSS', () => {
    const css = '@import url("/tokens.css"); @import "https://fonts.googleapis.com/css2?family=Newsreader";';
    const urls = findCssImportUrls(css, 'https://acme.test/styles/app.css');
    expect(urls).toContain('https://acme.test/tokens.css');
    expect(urls.some((u) => u.includes('fonts.googleapis.com'))).toBe(true);
  });
});
