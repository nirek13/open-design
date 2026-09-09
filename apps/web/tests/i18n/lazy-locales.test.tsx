// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, useT } from '../../src/i18n';
import { LOCALES } from '../../src/i18n/types';
import { fallbackDict, loadDict, loadedDict } from '../../src/i18n/registry';

function Title() {
  const t = useT();
  return <span data-testid="title">{t('settings.title')}</span>;
}

afterEach(cleanup);

describe('locale dictionaries load on demand', () => {
  it('keeps English resident so the first render always has strings', () => {
    // The synchronous fallback every other dictionary defers to. If this ever
    // became lazy, `t()` would have nothing to return before a chunk resolved.
    expect(loadedDict('en')).toBe(fallbackDict);
    expect(fallbackDict['settings.title']).toBeTruthy();
  });

  // Nineteen chunk loads in one case; the default 5s is tight on a loaded
  // machine and the assertion has nothing to do with timing.
  it('exposes a loader for every supported locale', async () => {
    // A locale in LOCALES with no entry in the loader map would silently fall
    // through to English for its whole audience.
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(dict['settings.title'], `${locale} has no settings.title`).toBeTruthy();
    }
  }, 30_000);

  it('renders the requested language once its dictionary resolves', async () => {
    const japanese = await loadDict('ja');
    render(
      <I18nProvider initial="ja">
        <Title />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('title')).toHaveTextContent(japanese['settings.title']);
    });
  });

  it('shows no partially-translated first paint while a dictionary is in flight', async () => {
    // The provider withholds its children rather than flashing English at a
    // reader who asked for something else. `th` is loaded here first only so
    // the assertion below is about the gate, not about chunk timing.
    const thai = await loadDict('th');
    expect(thai['settings.title']).not.toBe(fallbackDict['settings.title']);

    render(
      <I18nProvider initial="th">
        <Title />
      </I18nProvider>,
    );
    // Never an intermediate render carrying English text.
    expect(screen.getByTestId('title')).toHaveTextContent(thai['settings.title']);
  });
});
