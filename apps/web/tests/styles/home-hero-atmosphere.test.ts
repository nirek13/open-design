import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);
const homeAtmosphereCss = readFileSync(
  new URL('../../src/styles/home/home-atmosphere.css', import.meta.url),
  'utf8',
);
const homeIndexCss = readFileSync(
  new URL('../../src/styles/home/index.css', import.meta.url),
  'utf8',
);
const entranceCss = readFileSync(
  new URL('../../src/styles/entrance.css', import.meta.url),
  'utf8',
);
const workspacePageCss = readFileSync(
  new URL('../../src/components/workspace/WorkspacePage.module.css', import.meta.url),
  'utf8',
);
const workspaceHomeCss = readFileSync(
  new URL('../../src/components/workspace-home/WorkspaceHome.module.css', import.meta.url),
  'utf8',
);

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

/** Every rule whose selector mentions `needle`, as raw declaration blocks. */
function rulesMentioningSelector(css: string, needle: string): string[] {
  const out: string[] = [];
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of cssWithoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((match[1] ?? '').includes(needle)) out.push(match[2] ?? '');
  }
  return out;
}

function ruleValue(block: string, property: string): string {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('Home hero atmosphere', () => {
  it('keeps a local hero wash without a stacking context', () => {
    const hero = cssDeclarations(homeHeroCss, '.home-hero');
    expect(ruleValue(hero, 'background')).toBe('transparent');
    expect(hero).not.toMatch(/isolation\s*:/);
    expect(hero).not.toMatch(/z-index\s*:/);
    expect(homeHeroCss).toMatch(/\.home-hero__atmosphere/);
    expect(homeHeroCss).toMatch(/\.home-hero__orb--lamp/);
    expect(homeHeroCss).toMatch(/feTurbulence/);
    expect(homeHeroCss).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('elevates the composer on a raised surface instead of a flat panel', () => {
    const card = cssDeclarations(homeHeroCss, '.home-hero__input-card');
    expect(ruleValue(card, 'background')).toBe('var(--bg-elevated)');
    expect(ruleValue(card, 'box-shadow')).toBe('var(--shadow-md)');
    expect(ruleValue(card, 'z-index')).toBe('2');
  });

  it('keeps a focus ring on the composer without flattening its elevation', () => {
    const focused = cssDeclarations(homeHeroCss, '.home-hero__input-card:focus-within');
    expect(ruleValue(focused, 'box-shadow')).toMatch(/var\(--shadow-md\)/);
    expect(ruleValue(focused, 'box-shadow')).not.toBe('none');
  });
});

describe('Home canvas atmosphere', () => {
  it('loads the studio wash on the home entry canvas', () => {
    expect(homeIndexCss).toMatch(/home-atmosphere\.css/);
    expect(homeAtmosphereCss).toMatch(/entry-view-home/);
    expect(homeAtmosphereCss).toMatch(/--home-grain-fine/);
    expect(homeAtmosphereCss).toMatch(/--home-grain-soft/);
    expect(homeAtmosphereCss).not.toMatch(/repeating-linear-gradient/);
    expect(homeAtmosphereCss).toMatch(/feTurbulence/);
    expect(homeAtmosphereCss).not.toMatch(/isolation\s*:/);
  });

  it('does not also hand the entry-canvas wash to the workspace hub', () => {
    // The hub paints its own dawn on `.studio`. It used to take this wash as
    // well, under its own orb layer — three light sources compounding into a
    // muddy dome with a seam wherever one of them started.
    const workspaceRules = rulesMentioningSelector(homeAtmosphereCss, 'entry-view-workspace');
    expect(workspaceRules.length).toBeGreaterThan(0);
    for (const rule of workspaceRules) {
      expect(rule).not.toMatch(/background-image/);
    }
    // What the hub does keep is the transparent topbar veil, so its own light
    // can reach the top of the canvas instead of stopping at an opaque strip.
    expect(workspaceRules.some((rule) => /background:\s*(linear-gradient|transparent)/.test(rule))).toBe(true);
  });

  it('drifts the wash with transform-safe background motion and honors reduced motion', () => {
    expect(homeAtmosphereCss).toMatch(/@keyframes home-atmosphere-drift/);
    expect(homeAtmosphereCss).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(homeAtmosphereCss).toMatch(/animation:\s*none/);
  });

  it('paints the workspace hub studio wash on the page itself', () => {
    const studio = cssDeclarations(workspacePageCss, '.studio');
    expect(studio).not.toMatch(/repeating-linear-gradient/);
    expect(studio).toMatch(/radial-gradient/);
    expect(studio).toMatch(/var\(--accent/);
    // The dawn belongs to the one element that spans the pane, so it has no
    // edge to show; the grain that dithers it belongs to the layer above.
    expect(studio).not.toMatch(/feTurbulence/);
    expect(workspaceHomeCss).toMatch(/\.atmosphere/);
    expect(workspaceHomeCss).toMatch(/\.halo/);
    expect(workspaceHomeCss).toMatch(/\.underglow/);
    expect(workspaceHomeCss).toMatch(/\.greetingHero/);
    expect(workspaceHomeCss).toMatch(/view-transition-name:\s*od-studio-composer/);
    expect(workspaceHomeCss).toMatch(/@keyframes homeBeamDrift/);
    expect(workspaceHomeCss).toMatch(/@keyframes homeGreetingIn/);
    expect(workspaceHomeCss).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('dithers the hub wash exactly once, above every gradient', () => {
    // Falloffs this large quantise into visible concentric rings without
    // grain over the top — and two grain layers meeting mid-pane draw a
    // rectangle across the canvas, which is the bug the single pass fixes.
    expect([...workspaceHomeCss.matchAll(/feTurbulence/g)]).toHaveLength(1);
    expect(workspaceHomeCss).toMatch(/\.atmosphere::after/);
  });

  it('builds the hub composer as an elevated object', () => {
    const askBox = cssDeclarations(workspaceHomeCss, '.askBox');
    // It was transparent with no shadow, which left the one control that
    // matters as the least present thing on the screen.
    expect(ruleValue(askBox, 'background')).toMatch(/var\(--bg-elevated\)/);
    expect(ruleValue(askBox, 'box-shadow')).not.toBe('none');
    // Shadow ink, not `--text`: mixing a shadow against the text colour
    // inverts in dark mode and lights a rim around the box.
    expect(ruleValue(askBox, 'box-shadow')).not.toMatch(/var\(--text\)/);
  });

  it('morphs the first prompt into the studio composer', () => {
    expect(entranceCss).toMatch(/html\.od-studio-enter/);
    expect(entranceCss).toMatch(/view-transition-name:\s*od-studio-composer/);
    expect(entranceCss).toMatch(/@keyframes od-studio-leave/);
    expect(entranceCss).toMatch(/@keyframes od-studio-arrive/);
    expect(entranceCss).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
