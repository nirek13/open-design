// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInfo, AppConfig } from '../../../src/types';

const { streamViaDaemon, listMessages, saveMessage } = vi.hoisted(() => ({
  streamViaDaemon: vi.fn(),
  listMessages: vi.fn(),
  saveMessage: vi.fn(),
}));

vi.mock('../../../src/providers/daemon', () => ({
  streamViaDaemon: (...args: unknown[]) => streamViaDaemon(...args),
}));

vi.mock('../../../src/state/projects', () => ({
  listMessages: (...args: unknown[]) => listMessages(...args),
  saveMessage: (...args: unknown[]) => saveMessage(...args),
}));

import { useConversationChat } from '../../../src/components/workspace/useConversationChat';
import { BYOK_PROVIDER_REQUIRED_MESSAGE } from '../../../src/components/byok/preflight';
import { DEFAULT_CONFIG } from '../../../src/state/config';

const BYOK_CONFIG: AppConfig = {
  ...DEFAULT_CONFIG,
  mode: 'api',
  apiProtocol: 'anthropic',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  byokProfileId: 'byok-env-anthropic',
  byokCredentialConfigured: true,
  agentId: null,
};

const OPENCODE: AgentInfo = {
  id: 'byok-opencode',
  name: 'BYOK OpenCode',
  bin: 'opencode',
  available: true,
  models: [],
};

function agentsMap(...agents: AgentInfo[]): Map<string, AgentInfo> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

describe('useConversationChat', () => {
  beforeEach(() => {
    streamViaDaemon.mockReset();
    listMessages.mockReset();
    saveMessage.mockReset();
    listMessages.mockResolvedValue([]);
    saveMessage.mockResolvedValue(undefined);
    streamViaDaemon.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs Pages / Side Chat against BYOK OpenCode instead of requiring a local CLI agent', async () => {
    const { result } = renderHook(() =>
      useConversationChat('proj-1', 'conv-1', {
        config: BYOK_CONFIG,
        agentsById: agentsMap(OPENCODE),
        locale: 'en',
        sessionMode: 'design',
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.onSend('Build a wiki for this page', [], []);
    });

    await waitFor(() => expect(streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
    expect(streamViaDaemon.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        agentId: 'byok-opencode',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        model: 'claude-sonnet-4-5',
        byokProfileId: 'byok-env-anthropic',
        byokMediaDefaults: expect.objectContaining({
          imageModel: 'gpt-image-2',
          speechModel: 'gpt-4o-mini-tts',
        }),
      }),
    );
  });

  it('still runs BYOK when a leftover daemon-mode config has no local agent', async () => {
    const { result } = renderHook(() =>
      useConversationChat('proj-1', 'conv-1', {
        config: { ...BYOK_CONFIG, mode: 'daemon', agentId: null },
        agentsById: agentsMap(OPENCODE),
        locale: 'en',
        sessionMode: 'design',
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.onSend('Add a nested page', [], []);
    });

    await waitFor(() => expect(streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
    expect(streamViaDaemon.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId: 'byok-opencode' }),
    );
  });

  it('asks for BYOK settings when the API key profile is missing', async () => {
    const { result } = renderHook(() =>
      useConversationChat('proj-1', 'conv-1', {
        config: {
          ...BYOK_CONFIG,
          byokProfileId: undefined,
          byokCredentialConfigured: false,
        },
        agentsById: agentsMap(OPENCODE),
        locale: 'en',
        sessionMode: 'design',
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.onSend('hello', [], []);
    });

    expect(result.current.error).toBe(BYOK_PROVIDER_REQUIRED_MESSAGE);
    expect(streamViaDaemon).not.toHaveBeenCalled();
  });

  it('still routes Pages / Side Chat through BYOK OpenCode when the cached scan is stale', async () => {
    const { result } = renderHook(() =>
      useConversationChat('proj-1', 'conv-1', {
        config: BYOK_CONFIG,
        agentsById: agentsMap({ ...OPENCODE, available: false }),
        locale: 'en',
        sessionMode: 'design',
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.onSend('Summarize this page', [], []);
    });

    await waitFor(() => expect(streamViaDaemon).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
    expect(streamViaDaemon.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId: 'byok-opencode' }),
    );
  });
});
