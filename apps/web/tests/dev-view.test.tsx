// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DevView } from '../src/components/dev/DevView';
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

const REPO = {
  id: '1',
  owner: 'nexu-io',
  name: 'open-design',
  fullName: 'nexu-io/open-design',
  description: 'Design agent workspace',
  htmlUrl: 'https://github.com/nexu-io/open-design',
  private: false,
  fork: false,
  language: 'TypeScript',
  stars: 42,
  forks: 7,
  openIssues: 3,
  defaultBranch: 'main',
  pushedAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
};

function renderDev() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <DevView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('DevView', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null, bio: null, avatarUrl: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchConnectorStatuses').mockResolvedValue({
      github: { status: 'connected' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks to connect GitHub when the connector is idle', async () => {
    vi.spyOn(registry, 'fetchOrgGithubStatus').mockResolvedValue({
      connected: false,
      profile: null,
    });
    vi.spyOn(registry, 'fetchConnectorStatuses').mockResolvedValue({});
    renderDev();
    expect(await screen.findByTestId('dev-connect')).toBeTruthy();
    expect(await screen.findByText(/Connect GitHub under Integrations/)).toBeTruthy();
  });

  it('lists repositories once GitHub is connected', async () => {
    vi.spyOn(registry, 'fetchOrgGithubStatus').mockResolvedValue({
      connected: true,
      profile: { login: 'ada', name: 'Ada Lovelace', avatarUrl: null, htmlUrl: 'https://github.com/ada' },
    });
    vi.spyOn(registry, 'fetchOrgGithubRepos').mockResolvedValue({
      connected: true,
      profile: { login: 'ada', name: 'Ada Lovelace', avatarUrl: null, htmlUrl: 'https://github.com/ada' },
      repos: [REPO],
    });
    renderDev();
    expect(await screen.findByText('nexu-io/open-design')).toBeTruthy();
    expect(screen.getByText(/TypeScript/)).toBeTruthy();
  });
});
