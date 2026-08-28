/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PhoneChannelsPanel } from '../../src/components/phone/PhoneChannelsPanel';
import { I18nProvider } from '../../src/i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PhoneChannelsPanel', () => {
  it('lets you start an iMessage webhook from Integrations', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/phone/channels') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ channels: [], slackConnected: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/phone/channels') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { kind?: string };
        return new Response(JSON.stringify({
          id: 'ch-1',
          kind: body.kind,
          label: 'iMessage',
          status: 'pairing',
          pairingCode: 'OD-TEST',
          inboundUrl: 'http://127.0.0.1/api/phone/inbound/ch-1',
          inboundToken: 'secret-token',
          slackChannelId: null,
          slackChannelName: null,
          replyUrl: null,
          boundFrom: null,
          projectId: null,
          conversationId: null,
          lastInboundAt: null,
          lastError: null,
          createdAt: new Date().toISOString(),
        }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <I18nProvider>
        <PhoneChannelsPanel />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phone-channels')).toBeTruthy());
    screen.getByRole('button', { name: 'Create iMessage webhook' }).click();
    await waitFor(() => expect(screen.getByText('OD-TEST')).toBeTruthy());
    expect(screen.getByText('secret-token')).toBeTruthy();
  });
});
