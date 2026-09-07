// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvatarMenu } from '../../src/components/AvatarMenu';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: analyticsMocks.track,
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      setConfigureGlobals: vi.fn(),
      setUserId: vi.fn(),
      anonymousId: 'test-anonymous-id',
      sessionId: 'test-session-id',
      newRequestId: () => 'test-request-id',
    }),
  };
});

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'openai',
  apiVersion: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiProviderBaseUrl: 'https://api.openai.com/v1',
  apiProtocolConfigs: {},
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const agents: AgentInfo[] = [{
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.80.0',
  models: [{ id: 'default', label: 'Default' }],
}];

afterEach(() => {
  cleanup();
});

describe('hidden Local CLI usage', () => {
  it('does not offer Local CLI in the inline execution switcher', () => {
    render(
      <I18nProvider initial="en">
        <InlineModelSwitcher
          config={config}
          agents={agents}
          providerModelsCache={{}}
          daemonLive={true}
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();
    expect(screen.queryByTestId('inline-model-switcher-mode-daemon')).toBeNull();
    expect(screen.queryByRole('tab', { name: /Local CLI/i })).toBeNull();
  });

  it('does not offer Local CLI in the avatar execution menu', () => {
    render(
      <I18nProvider initial="en">
        <AvatarMenu
          config={config}
          agents={agents}
          daemonLive={true}
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiModelChange={vi.fn()}
          providerModelsCache={{}}
          onOpenSettings={vi.fn()}
          onRefreshAgents={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Account & settings/i }));
    expect(screen.queryByRole('button', { name: /Use Local CLI|avatar.useLocal/i })).toBeNull();
  });
});
