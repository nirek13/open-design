// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChromeSearchTrigger } from '../../src/components/search/ChromeSearchTrigger';
import {
  searchShortcutLabel,
  TOGGLE_SEARCH_EVENT,
} from '../../src/components/search/search-hotkey';
import { I18nProvider } from '../../src/i18n';

describe('ChromeSearchTrigger', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens the same spotlight search as Command+1', () => {
    const seen: Event[] = [];
    const onToggle = (event: Event) => seen.push(event);
    window.addEventListener(TOGGLE_SEARCH_EVENT, onToggle);

    render(
      <I18nProvider initial="en">
        <ChromeSearchTrigger />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('chrome-search-trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toContain(searchShortcutLabel());

    fireEvent.click(trigger);
    expect(seen).toHaveLength(1);

    window.removeEventListener(TOGGLE_SEARCH_EVENT, onToggle);
  });

  it('marks the control expanded while the palette is open', () => {
    render(
      <I18nProvider initial="en">
        <ChromeSearchTrigger open />
      </I18nProvider>,
    );
    expect(screen.getByTestId('chrome-search-trigger').getAttribute('aria-expanded')).toBe('true');
  });
});
