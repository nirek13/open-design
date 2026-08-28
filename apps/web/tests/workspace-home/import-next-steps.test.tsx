// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPlan } from '@open-design/contracts';

import { ImportNextSteps } from '../../src/components/workspace-home/ImportNextSteps';
import { I18nProvider } from '../../src/i18n';

const PLAN: ImportPlan = {
  tableName: 'tenders',
  displayName: 'Tenders',
  appendingToExisting: false,
  sourceUrl: 'https://example.com/tenders.csv',
  columns: [
    {
      header: 'Title',
      fieldName: 'title',
      type: 'text',
      reason: 'free-form',
      sample: ['NPP'],
    },
  ],
  rowCount: 1,
  skipped: [],
};

describe('ImportNextSteps', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks what the interface should do before starting the builder', async () => {
    const onAskProject = vi.fn().mockResolvedValue(true);
    render(
      <I18nProvider initial="en">
        <ImportNextSteps plan={PLAN} sourceUrl={PLAN.sourceUrl} onView={() => {}} onAskProject={onAskProject} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId('import-next-build'));
    expect(screen.getByTestId('import-next-build-draft')).toBeTruthy();
    expect(onAskProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('import-next-build-prompt'), {
      target: { value: 'A board of open tenders grouped by closing week' },
    });
    expect((screen.getByTestId('import-next-build-prompt') as HTMLTextAreaElement).value).toBe(
      'A board of open tenders grouped by closing week',
    );
    fireEvent.click(screen.getByTestId('import-next-build-submit'));
    await waitFor(() => {
      expect(onAskProject).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('A board of open tenders grouped by closing week'),
          conversationMode: 'design',
        }),
      );
    });
  });
});
