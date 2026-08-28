// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { OrgMark } from '../../../src/components/org/OrgMark';

afterEach(() => {
  cleanup();
});

describe('OrgMark', () => {
  it('prefers the harvested org mark over a public favicon lookup', () => {
    render(
      <OrgMark
        orgId="ws-1"
        markVersion={9}
        websiteUrl="https://stripe.com"
        data-testid="mark"
      />,
    );
    const img = screen.getByTestId('mark');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('/api/orgs/ws-1/mark?v=9');
  });

  it('falls back to the website favicon when the harvested mark is missing', () => {
    render(
      <OrgMark orgId="ws-1" websiteUrl="https://stripe.com" data-testid="mark" />,
    );
    fireEvent.error(screen.getByTestId('mark'));
    const favicon = screen.getByTestId('mark');
    expect(favicon.tagName).toBe('IMG');
    expect(favicon.getAttribute('src')).toContain('domain=stripe.com');
  });

  it('falls back to the Substrate glyph when the favicon fails to load', () => {
    render(<OrgMark websiteUrl="https://stripe.com" data-testid="mark" />);
    const img = screen.getByTestId('mark');
    expect(img.tagName).toBe('IMG');
    fireEvent.error(img);
    const glyph = screen.getByTestId('mark');
    expect(glyph.tagName).toBe('SPAN');
    expect(glyph.className).toContain('od-brand-glyph');
  });
});
