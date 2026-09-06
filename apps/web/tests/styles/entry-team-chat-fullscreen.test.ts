import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryLayoutCss = readFileSync(
  new URL('../../src/styles/home/entry-layout.css', import.meta.url),
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

describe('entry team chat fullscreen styles', () => {
  it('pins team chat and slack to the remaining viewport like mail', () => {
    const team = cssDeclarations(
      entryLayoutCss,
      ".entry-main__inner--fullscreen > [data-testid='entry-view-team']",
    );
    const slack = cssDeclarations(
      entryLayoutCss,
      ".entry-main__inner--fullscreen > [data-testid='entry-view-slack']",
    );
    const mail = cssDeclarations(
      entryLayoutCss,
      ".entry-main__inner--fullscreen > [data-testid='entry-view-mail']",
    );

    const workspace = cssDeclarations(
      entryLayoutCss,
      ".entry-main__inner--fullscreen > [data-testid='entry-view-workspace']",
    );

    expect(ruleValue(team, 'flex')).toBe(ruleValue(mail, 'flex'));
    expect(ruleValue(team, 'overflow')).toBe('hidden');
    expect(ruleValue(slack, 'overflow')).toBe('hidden');
    expect(ruleValue(workspace, 'overflow')).toBe('hidden');
    expect(ruleValue(team, 'min-height')).toBe('0');
    expect(ruleValue(workspace, 'flex')).toBe(ruleValue(mail, 'flex'));
  });

  it('floats the entry topbar over team chat so the workspace is edge-to-edge', () => {
    const topbar = cssDeclarations(
      entryLayoutCss,
      ".entry-main--scroll:has([data-testid='entry-view-team'][data-active='true']) .entry-main__topbar",
    );
    expect(ruleValue(topbar, 'position')).toBe('absolute');
    expect(ruleValue(topbar, 'background')).toBe('transparent');
  });
});
