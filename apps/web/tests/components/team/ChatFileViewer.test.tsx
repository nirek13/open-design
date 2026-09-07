/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { ChatFilePreview, PendingChatFile } from '../../../src/components/team/ChatFileViewer';
import { I18nProvider } from '../../../src/i18n';

afterEach(() => {
  cleanup();
});

function renderViewer(node: ReactNode) {
  return render(<I18nProvider initial="en">{node}</I18nProvider>);
}

describe('ChatFileViewer', () => {
  it('renders markdown in the send preview and opens a built-in viewer', async () => {
    const file = new File(['# Handbook\n\nShip the deck.'], 'handbook.md', { type: 'text/markdown' });
    renderViewer(
      <PendingChatFile file={file} removeLabel="Remove attachment" onRemove={() => undefined} />,
    );
    expect(await screen.findByRole('heading', { name: 'Handbook' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('team-pending-handbook.md'));
    expect(await screen.findByTestId('team-file-viewer')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'handbook.md' })).toBeTruthy();
  });

  it('renders a csv table from a posted file', async () => {
    const file = new File(['name,role\nAda,Design'], 'roster.csv', { type: 'text/csv' });
    renderViewer(
      <ChatFilePreview
        source={{ url: 'blob:csv', fileName: 'roster.csv', mimeType: 'text/csv', byteSize: file.size, file }}
        testId="team-file-csv-1"
      />,
    );
    expect(await screen.findByRole('columnheader', { name: 'name' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('team-file-csv-1'));
    expect(await screen.findByTestId('team-file-viewer')).toBeTruthy();
  });

  it('pretty-prints json in the message preview', async () => {
    const file = new File(['{"ok":true}'], 'status.json', { type: 'application/json' });
    renderViewer(
      <ChatFilePreview
        source={{ url: 'blob:json', fileName: 'status.json', mimeType: 'application/json', file }}
        testId="team-file-json-1"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/"ok": true/)).toBeTruthy();
    });
  });
});
