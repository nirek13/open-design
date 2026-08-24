import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokensCss = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const createAppFlowCss = readFileSync(
  new URL('../../src/components/apps/CreateAppFlow.module.css', import.meta.url),
  'utf8',
);
const sendAppPickerCss = readFileSync(
  new URL('../../src/components/apps/SendAppPicker.module.css', import.meta.url),
  'utf8',
);
const toolsCss = readFileSync(new URL('../../src/styles/viewer/tools.css', import.meta.url), 'utf8');

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`Missing CSS block for ${selector}`);
  return match[1] ?? '';
}

function ruleValue(block: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(block);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('theme surface aliases', () => {
  it('maps legacy surface names onto the canonical theme tokens', () => {
    expect(tokensCss).toMatch(/--surface-0:\s*var\(--bg\);/);
    expect(tokensCss).toMatch(/--surface-1:\s*var\(--bg-elevated\);/);
    expect(tokensCss).toMatch(/--surface-2:\s*var\(--bg-subtle\);/);
    expect(tokensCss).toMatch(/--od-surface-1:\s*var\(--bg-elevated\);/);
    expect(tokensCss).toMatch(/--text-2:\s*var\(--text-muted\);/);
    expect(tokensCss).toMatch(/--danger:\s*var\(--red\);/);
  });

  it('keeps the deploy-app panel on theme tokens instead of a hardcoded dark surface', () => {
    const panel = cssBlock(createAppFlowCss, '.panel');
    const title = cssBlock(createAppFlowCss, '.title');
    const liveUrl = cssBlock(createAppFlowCss, '.liveUrl');

    expect(ruleValue(panel, 'background')).toBe('var(--bg-elevated)');
    expect(ruleValue(panel, 'color')).toBe('var(--text)');
    expect(panel).not.toContain('#161618');
    expect(ruleValue(title, 'color')).toBe('var(--text)');
    expect(ruleValue(liveUrl, 'color')).toBe('var(--text)');
  });

  it('keeps send-app copy on muted theme text instead of a fixed gray', () => {
    const lead = cssBlock(sendAppPickerCss, '.lead,\n.empty');
    const section = cssBlock(sendAppPickerCss, '.section');
    const note = cssBlock(sendAppPickerCss, '.note');

    expect(sendAppPickerCss).not.toContain('rgba(160, 160, 160');
    expect(ruleValue(lead, 'color')).toBe('var(--text-muted)');
    expect(ruleValue(section, 'color')).toBe('var(--text-muted)');
    expect(ruleValue(note, 'color')).toBe('var(--text-muted)');
  });

  it('does not pad a second light frame around the deploy-app panel', () => {
    const modal = cssBlock(toolsCss, '.deploy-modal');

    expect(ruleValue(modal, 'padding')).toBe('0');
    expect(ruleValue(modal, 'background')).toBe('var(--bg-elevated)');
    expect(ruleValue(modal, 'color')).toBe('var(--text)');
  });
});
