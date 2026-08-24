// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MailView } from '../src/components/mail/MailView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

const MESSAGE = {
  id: 'm1',
  threadId: 't1',
  subject: 'Q3 budget',
  snippet: 'Please review the attached budget.',
  from: 'Ada <ada@example.com>',
  to: ['team@example.com'],
  cc: [],
  date: null,
  internalDate: Date.now(),
  labelIds: ['INBOX', 'UNREAD'],
  unread: true,
  starred: false,
  text: 'Please review the attached budget.',
  html: null,
  attachments: [],
};

function renderMail() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <MailView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('MailView', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchConnectorStatuses').mockResolvedValue({
      gmail: { status: 'connected' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks to connect Gmail when the connector is idle', async () => {
    vi.spyOn(registry, 'fetchOrgMailStatus').mockResolvedValue({
      connected: false,
      profile: null,
      labels: [],
    });
    vi.spyOn(registry, 'fetchConnectorStatuses').mockResolvedValue({});
    renderMail();
    expect(await screen.findByTestId('mail-connect')).toBeTruthy();
    expect(await screen.findByText(/Connect Gmail under Integrations/)).toBeTruthy();
  });

  it('lists inbox messages and opens a thread', async () => {
    vi.spyOn(registry, 'fetchOrgMailStatus').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 12, threadsTotal: 8 },
      labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 1, messagesTotal: 12 }],
    });
    vi.spyOn(registry, 'fetchOrgMailMessages').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 12, threadsTotal: 8 },
      messages: [MESSAGE],
      nextPageToken: null,
      resultSizeEstimate: 1,
    });
    vi.spyOn(registry, 'fetchOrgMailThread').mockResolvedValue({
      thread: { id: 't1', messages: [{ ...MESSAGE, unread: false, html: null }] },
    });

    renderMail();
    expect(await screen.findByText('Q3 budget')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    fireEvent.click(screen.getByText('Q3 budget'));
    await waitFor(() => {
      expect(registry.fetchOrgMailThread).toHaveBeenCalledWith('ws-1', 't1');
    });
    expect(await screen.findByLabelText('Reply')).toBeTruthy();
    expect(screen.getByText('Ada <ada@example.com>')).toBeTruthy();
  });

  it('opens compose from the inbox', async () => {
    vi.spyOn(registry, 'fetchOrgMailStatus').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 0, threadsTotal: 0 },
      labels: [],
    });
    vi.spyOn(registry, 'fetchOrgMailMessages').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 0, threadsTotal: 0 },
      messages: [],
      nextPageToken: null,
      resultSizeEstimate: 0,
    });
    renderMail();
    fireEvent.click(await screen.findByTestId('mail-compose'));
    expect(screen.getByLabelText('Compose')).toBeTruthy();
    expect(screen.getByText('Send')).toBeTruthy();
  });

  it('opens a thread with Enter and the command palette with ⌘K', async () => {
    vi.spyOn(registry, 'fetchOrgMailStatus').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 12, threadsTotal: 8 },
      labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 1, messagesTotal: 12 }],
    });
    vi.spyOn(registry, 'fetchOrgMailMessages').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 12, threadsTotal: 8 },
      messages: [MESSAGE],
      nextPageToken: null,
      resultSizeEstimate: 1,
    });
    vi.spyOn(registry, 'fetchOrgMailThread').mockResolvedValue({
      thread: { id: 't1', messages: [{ ...MESSAGE, unread: false, html: null }] },
    });

    renderMail();
    expect(await screen.findByText('Q3 budget')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => {
      expect(registry.fetchOrgMailThread).toHaveBeenCalledWith('ws-1', 't1');
    });

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByTestId('mail-command-palette')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('mail-command-palette')).toBeNull();
    });

    fireEvent.keyDown(window, { key: 'c' });
    expect(await screen.findByLabelText('Compose')).toBeTruthy();
  });

  it('fits an html letter to its full height instead of a nested viewport', async () => {
    const html = '<p>Please review the attached budget in full.</p>';
    vi.spyOn(registry, 'fetchOrgMailStatus').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 12, threadsTotal: 8 },
      labels: [{ id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 1, messagesTotal: 12 }],
    });
    vi.spyOn(registry, 'fetchOrgMailMessages').mockResolvedValue({
      connected: true,
      profile: { emailAddress: 'ada@example.com', messagesTotal: 12, threadsTotal: 8 },
      messages: [MESSAGE],
      nextPageToken: null,
      resultSizeEstimate: 1,
    });
    vi.spyOn(registry, 'fetchOrgMailThread').mockResolvedValue({
      thread: { id: 't1', messages: [{ ...MESSAGE, unread: false, html }] },
    });

    renderMail();
    fireEvent.click(await screen.findByText('Q3 budget'));
    const frame = await screen.findByTestId('mail-body-frame');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc') ?? '').toContain(html);
  });
});
