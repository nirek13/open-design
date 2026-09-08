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
    expect(homeAtmosphereCss).toMatch(/entry-view-workspace/);
    expect(homeAtmosphereCss).toMatch(/--home-grain-fine/);
    expect(homeAtmosphereCss).toMatch(/--home-grain-soft/);
    expect(homeAtmosphereCss).not.toMatch(/repeating-linear-gradient/);
    expect(homeAtmosphereCss).toMatch(/feTurbulence/);
    expect(homeAtmosphereCss).not.toMatch(/isolation\s*:/);
  });

  it('drifts the wash with transform-safe background motion and honors reduced motion', () => {
    expect(homeAtmosphereCss).toMatch(/@keyframes home-atmosphere-drift/);
    expect(homeAtmosphereCss).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(homeAtmosphereCss).toMatch(/animation:\s*none/);
  });

  it('paints the workspace hub studio wash on the page itself', () => {
    const studio = cssDeclarations(workspacePageCss, '.studio');
    expect(studio).toMatch(/--home-grain-fine/);
    expect(studio).not.toMatch(/repeating-linear-gradient/);
    expect(studio).toMatch(/radial-gradient/);
    expect(studio).toMatch(/var\(--accent/);
    expect(workspaceHomeCss).toMatch(/\.atmosphere/);
    expect(workspaceHomeCss).toMatch(/\.orbLamp/);
    expect(workspaceHomeCss).toMatch(/\.grain/);
    expect(workspaceHomeCss).toMatch(/\.greetingHero/);
    expect(workspaceHomeCss).toMatch(/view-transition-name:\s*od-studio-composer/);
    expect(workspaceHomeCss).toMatch(/@keyframes homeOrbDrift/);
    expect(workspaceHomeCss).toMatch(/@keyframes homeGreetingIn/);
    expect(workspaceHomeCss).toMatch(/prefers-reduced-motion:\s*reduce/);
    const askBox = cssDeclarations(workspaceHomeCss, '.askBox');
    expect(ruleValue(askBox, 'background')).toBe('transparent');
    expect(ruleValue(askBox, 'box-shadow')).toBe('none');
  });

  it('morphs the first prompt into the studio composer', () => {
    expect(entranceCss).toMatch(/html\.od-studio-enter/);
    expect(entranceCss).toMatch(/view-transition-name:\s*od-studio-composer/);
    expect(entranceCss).toMatch(/@keyframes od-studio-leave/);
    expect(entranceCss).toMatch(/@keyframes od-studio-arrive/);
    expect(entranceCss).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
