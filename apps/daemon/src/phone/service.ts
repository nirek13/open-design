import { randomUUID } from 'node:crypto';

import type {
  ApiErrorCode,
  PhoneChannel,
  PhoneChannelSecret,
  PhoneInboundResponse,
} from '@open-design/contracts';

import { createSlackExecutor, sendSlackMessage, SLACK_CONNECTOR_ID } from '../workspace-data/slack.js';
import type { ConnectorService } from '../connectors/service.js';
import { formatPhoneReply, phoneWorkingAck } from './format-reply.js';
import { parsePhoneInbound } from './parse-inbound.js';
import {
  createPhoneStore,
  toPublicPhoneChannel,
  type PhoneChannelRecord,
  type PhoneStore,
} from './store.js';
import { hashPhoneToken, pairingCodeInText, phoneTokenHashesMatch } from './tokens.js';

export interface PhoneRunRequest {
  channelId: string;
  prompt: string;
  sourceLabel: string;
}

export interface PhoneRunResult {
  runId: string;
  projectId: string;
  conversationId: string;
  status: 'succeeded' | 'failed' | 'canceled';
  text: string;
  studioUrl: string | null;
}

export type PhoneRunHandler = (request: PhoneRunRequest) => Promise<PhoneRunResult>;

export interface PhoneServiceOptions {
  dataDir: string;
  connectors: ConnectorService;
  inboundUrlFor: (channelId: string) => string;
  now?: () => Date;
}

const SLACK_POLL_MS = 12_000;

export function createPhoneService(options: PhoneServiceOptions) {
  const store: PhoneStore = createPhoneStore(options.dataDir);
  const now = options.now ?? (() => new Date());
  let runHandler: PhoneRunHandler | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let stopped = false;

  function setRunHandler(handler: PhoneRunHandler | null): void {
    runHandler = handler;
  }

  function publicChannel(record: PhoneChannelRecord): PhoneChannel {
    return toPublicPhoneChannel(record, options.inboundUrlFor(record.id));
  }

  function withSecret(record: PhoneChannelRecord, inboundToken: string): PhoneChannelSecret {
    return { ...publicChannel(record), inboundToken };
  }

  function slackConnected(): boolean {
    try {
      return Boolean(options.connectors.getCredential(SLACK_CONNECTOR_ID)?.credentials);
    } catch {
      return false;
    }
  }

  function slackExecutor() {
    const credentials = options.connectors.getCredential(SLACK_CONNECTOR_ID)?.credentials;
    return createSlackExecutor(credentials);
  }

  function listChannels(): { channels: PhoneChannel[]; slackConnected: boolean } {
    return {
      channels: store.list().map(publicChannel),
      slackConnected: slackConnected(),
    };
  }

  function createChannel(input: {
    kind: 'slack' | 'imessage';
    ownerUserId: string;
    label?: string;
    slackChannelId?: string;
    slackChannelName?: string;
    replyUrl?: string;
    replyToken?: string;
  }): PhoneChannelSecret {
    if (input.kind === 'slack' && !slackConnected()) {
      throw new PhoneServiceError('CONNECTOR_NOT_CONNECTED', 400, 'Connect Slack under Integrations first');
    }
    if (input.kind === 'slack' && !input.slackChannelId?.trim()) {
      throw new PhoneServiceError('VALIDATION_FAILED', 422, 'Pick a Slack channel or DM to watch');
    }
    const created = store.create(input);
    return withSecret(created.record, created.inboundToken);
  }

  function patchChannel(id: string, patch: {
    status?: 'active' | 'paused';
    slackChannelId?: string;
    slackChannelName?: string;
    replyUrl?: string | null;
    replyToken?: string | null;
    label?: string;
  }): PhoneChannel {
    const existing = store.get(id);
    if (!existing) throw new PhoneServiceError('CHANNEL_NOT_FOUND', 404, 'phone channel not found');
    const next: PhoneChannelRecord = { ...existing };
    if (patch.status) next.status = patch.status;
    if (patch.slackChannelId !== undefined) next.slackChannelId = patch.slackChannelId.trim() || null;
    if (patch.slackChannelName !== undefined) next.slackChannelName = patch.slackChannelName.trim() || null;
    if (patch.replyUrl !== undefined) next.replyUrl = patch.replyUrl?.trim() || null;
    if (patch.replyToken !== undefined) next.replyToken = patch.replyToken?.trim() || null;
    if (patch.label !== undefined && patch.label.trim()) next.label = patch.label.trim();
    if (next.kind === 'slack' && next.slackChannelId && next.status === 'pairing') {
      next.status = 'active';
      next.pairingCode = null;
    }
    return publicChannel(store.save(next));
  }

  function deleteChannel(id: string): void {
    if (!store.remove(id)) throw new PhoneServiceError('CHANNEL_NOT_FOUND', 404, 'phone channel not found');
  }

  function rotateChannel(id: string): PhoneChannelSecret {
    const rotated = store.rotateToken(id);
    if (!rotated) throw new PhoneServiceError('CHANNEL_NOT_FOUND', 404, 'phone channel not found');
    return withSecret(rotated.record, rotated.inboundToken);
  }

  function authorizeInbound(id: string, bearer: string | null): PhoneChannelRecord {
    const record = store.get(id);
    if (!record) throw new PhoneServiceError('CHANNEL_NOT_FOUND', 404, 'phone channel not found');
    if (!bearer || !phoneTokenHashesMatch(record.inboundTokenHash, hashPhoneToken(bearer))) {
      throw new PhoneServiceError('UNAUTHORIZED', 401, 'invalid phone inbound token');
    }
    return record;
  }

  async function deliverReply(record: PhoneChannelRecord, text: string, threadTs: string | null): Promise<string | null> {
    if (record.kind === 'slack' && record.slackChannelId && slackConnected()) {
      try {
        const sent = await sendSlackMessage(slackExecutor(), {
          channelId: record.slackChannelId,
          text,
          ...(threadTs ? { threadTs } : {}),
        });
        return sent.ts;
      } catch (error) {
        throw error;
      }
    }
    if (!record.replyUrl) return null;
    const payload = blueBubblesReplyPayload(record, text, threadTs);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (record.replyToken) {
      headers.authorization = `Bearer ${record.replyToken}`;
      headers['x-guid'] = record.replyToken;
    }
    const resp = await fetch(record.replyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`reply webhook failed: HTTP ${resp.status} ${body.slice(0, 200)}`);
    }
    return threadTs;
  }

  async function runJob(record: PhoneChannelRecord, prompt: string, threadTs: string | null): Promise<void> {
    const handler = runHandler;
    if (!handler) {
      store.save({ ...record, lastError: 'Open Design is not ready to run phone jobs yet' });
      return;
    }
    const busy = store.save({ ...record, busyRunId: `pending-${randomUUID()}`, lastError: null });
    try {
      if (busy.kind === 'slack' && busy.slackChannelId) {
        await deliverReply(busy, phoneWorkingAck('slack'), threadTs).catch(() => undefined);
      }
      const result = await handler({
        channelId: busy.id,
        prompt,
        sourceLabel: busy.kind === 'slack' ? 'Slack' : 'iMessage',
      });
      const latest = store.get(busy.id) ?? busy;
      const reply = formatPhoneReply({
        text: result.text,
        studioUrl: result.studioUrl,
        failed: result.status !== 'succeeded',
      });
      const outboundTs = await deliverReply(latest, reply, threadTs);
      store.save({
        ...latest,
        busyRunId: null,
        projectId: result.projectId,
        conversationId: result.conversationId,
        lastOutboundTs: outboundTs ?? latest.lastOutboundTs,
        lastError: result.status === 'succeeded' ? null : (result.text || result.status),
      });
    } catch (error) {
      const latest = store.get(busy.id) ?? busy;
      const message = error instanceof Error ? error.message : String(error);
      store.save({ ...latest, busyRunId: null, lastError: message });
      await deliverReply(
        latest,
        formatPhoneReply({ text: '', failed: true, studioUrl: null }),
        threadTs,
      ).catch(() => undefined);
    }
  }

  function acceptInbound(record: PhoneChannelRecord, text: string, from: string | null, threadTs: string | null): PhoneInboundResponse {
    const trimmed = text.trim();
    if (!trimmed) return { ok: true, status: 'ignored', message: 'empty message' };

    if (record.status === 'paused') {
      return { ok: true, status: 'ignored', message: 'channel is paused' };
    }

    if (record.status === 'pairing') {
      if (!record.pairingCode || !pairingCodeInText(trimmed, record.pairingCode)) {
        return {
          ok: true,
          status: 'ignored',
          message: `Send ${record.pairingCode ?? 'your pairing code'} to link this phone`,
        };
      }
      const paired = store.save({
        ...record,
        status: 'active',
        pairingCode: null,
        boundFrom: from,
        lastInboundAt: now().toISOString(),
      });
      void deliverReply(
        paired,
        'Linked. Text Open Design from this thread and I will run it.',
        threadTs,
      ).catch(() => undefined);
      return { ok: true, status: 'paired', message: 'phone linked' };
    }

    if (record.boundFrom && from && record.boundFrom !== from) {
      return { ok: true, status: 'ignored', message: 'unknown sender' };
    }
    if (record.busyRunId) {
      return { ok: true, status: 'ignored', message: 'already working on the last message' };
    }

    const queued = store.save({
      ...record,
      lastInboundAt: now().toISOString(),
      boundFrom: record.boundFrom ?? from,
    });
    void runJob(queued, trimmed, threadTs);
    return { ok: true, status: 'queued' };
  }

  function handleInbound(id: string, bearer: string | null, body: unknown): PhoneInboundResponse {
    const record = authorizeInbound(id, bearer);
    if (isSlackUrlVerification(body)) {
      return { ok: true, status: 'ignored', message: 'url_verification' };
    }
    const parsed = parsePhoneInbound(body);
    if (!parsed || parsed.echo) {
      return { ok: true, status: 'ignored', message: parsed?.echo ? 'echo' : 'unrecognized payload' };
    }
    return acceptInbound(record, parsed.text, parsed.from, parsed.threadTs);
  }

  function slackUrlChallenge(body: unknown): string | null {
    const rec = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    if (!rec || rec.type !== 'url_verification') return null;
    return typeof rec.challenge === 'string' ? rec.challenge : null;
  }

  async function pollSlackOnce(): Promise<void> {
    if (!slackConnected()) return;
    const { listSlackMessages } = await import('../workspace-data/slack.js');
    const exec = slackExecutor();
    for (const channel of store.list()) {
      if (stopped) return;
      if (channel.kind !== 'slack' || channel.status !== 'active' || !channel.slackChannelId) continue;
      if (channel.busyRunId) continue;
      try {
        const page = await listSlackMessages(exec, channel.slackChannelId, { limit: 20 });
        const chronological = page.messages;
        const newestTs = chronological[chronological.length - 1]?.ts ?? null;
        if (!channel.lastSlackTs) {
          store.save({ ...channel, lastSlackTs: newestTs ?? '0' });
          continue;
        }
        const pending = chronological.filter((message) => {
          if (!message.text.trim()) return false;
          if (Number(message.ts) <= Number(channel.lastSlackTs)) return false;
          if (channel.lastOutboundTs && message.ts === channel.lastOutboundTs) return false;
          if (message.userId && channel.boundFrom && message.userId !== channel.boundFrom) return false;
          return true;
        });
        const next = pending[0];
        if (!next) {
          if (newestTs && newestTs !== channel.lastSlackTs) {
            store.save({ ...channel, lastSlackTs: newestTs });
          }
          continue;
        }
        const latest = store.save({
          ...channel,
          lastSlackTs: next.ts,
          boundFrom: channel.boundFrom ?? next.userId,
        });
        acceptInbound(latest, next.text, next.userId, next.threadTs ?? next.ts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.save({ ...channel, lastError: message });
      }
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (polling || stopped) return;
      polling = true;
      void pollSlackOnce().finally(() => {
        polling = false;
      });
    }, SLACK_POLL_MS);
    pollTimer.unref?.();
  }

  function stop(): void {
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    listChannels,
    createChannel,
    patchChannel,
    deleteChannel,
    rotateChannel,
    handleInbound,
    slackUrlChallenge,
    slackConnected,
    setRunHandler,
    startPolling,
    stop,
    pollSlackOnce,
    store,
  };
}

export type PhoneService = ReturnType<typeof createPhoneService>;

export class PhoneServiceError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = 'PhoneServiceError';
    this.code = code;
    this.status = status;
  }
}

function isSlackUrlVerification(body: unknown): boolean {
  const rec = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  return rec?.type === 'url_verification';
}

function blueBubblesReplyPayload(
  record: PhoneChannelRecord,
  text: string,
  threadTs: string | null,
): Record<string, unknown> {
  const replyUrl = record.replyUrl ?? '';
  if (/\/api\/v1\/message/i.test(replyUrl)) {
    return {
      chatGuid: threadTs || record.boundFrom,
      message: text,
      method: 'apple-script',
    };
  }
  return {
    text,
    to: record.boundFrom,
    ...(threadTs ? { threadTs } : {}),
  };
}

export function phoneStudioUrl(
  webBaseUrl: string | null | undefined,
  projectId: string,
  conversationId: string,
): string | null {
  if (!webBaseUrl) return null;
  const base = webBaseUrl.replace(/\/+$/u, '');
  return `${base}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
}
