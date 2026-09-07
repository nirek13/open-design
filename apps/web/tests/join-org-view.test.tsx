// @vitest-environment jsdom

// The invite landing page has to name the organization before asking for
// anything, then actually join when the visitor confirms.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JoinOrgView } from '../src/components/org/JoinOrgView';
import { I18nProvider } from '../src/i18n';
import * as registry from '../src/providers/registry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('JoinOrgView', () => {
  it('shows the organization and joins when the visitor accepts', async () => {
    vi.spyOn(registry, 'fetchInvitePreview').mockResolvedValue({
      valid: true,
      orgName: 'Northwind',
      role: 'member',
    });
    const accept = vi.spyOn(registry, 'acceptInvite').mockResolvedValue({
      organization: { id: 'ws-1', name: 'Northwind' },
    });

    render(
      <I18nProvider initial="en">
        <JoinOrgView token="tok-1" />
      </I18nProvider>,
    );

    expect(await screen.findByText('Northwind')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('join-accept'));
    expect(await screen.findByText(/you are in/i)).toBeInTheDocument();
    expect(accept).toHaveBeenCalledWith('tok-1');
    expect(sessionStorage.getItem('open-design:pending-invite:v1')).toBeNull();
  });
});
