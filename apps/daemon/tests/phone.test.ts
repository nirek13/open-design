import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatPhoneReply, stripPhoneMarkup } from '../src/phone/format-reply.js';
import { parsePhoneInbound } from '../src/phone/parse-inbound.js';
import { createPhoneService } from '../src/phone/service.js';
import { createPhoneStore } from '../src/phone/store.js';
import { generatePairingCode, pairingCodeInText } from '../src/phone/tokens.js';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'od-phone-'));
}

function disconnectedConnectors() {
  return {
    getCredential: () => undefined,
  } as never;
}

describe('phone pairing codes', () => {
  it('matches the code even with extra words and spacing', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^OD-[A-Z2-9]{4}$/);
    expect(pairingCodeInText(`hi ${code.toLowerCase()} please`, code)).toBe(true);
    expect(pairingCodeInText('nope', code)).toBe(false);
  });
});

describe('parsePhoneInbound', () => {
  it('reads a Shortcut-style body', () => {
    expect(parsePhoneInbound({ text: 'make a landing page', from: '+15551212' })).toEqual({
      text: 'make a landing page',
      from: '+15551212',
      threadTs: null,
      echo: false,
    });
  });

  it('reads a BlueBubbles new-message envelope and skips echoes', () => {
    const parsed = parsePhoneInbound({
      type: 'new-message',
      data: {
        text: 'ship the deck',
        guid: 'ABC',
        isFromMe: false,
        handle: { address: '+15550000' },
      },
    });
    expect(parsed).toMatchObject({ text: 'ship the deck', from: '+15550000', echo: false });
    expect(parsePhoneInbound({
      type: 'new-message',
      data: { text: 'mine', isFromMe: true, handle: { address: '+15550000' } },
    })?.echo).toBe(true);
  });

  it('reads a Slack message event', () => {
    const parsed = parsePhoneInbound({
      event: { type: 'message', text: 'hello', user: 'U1', ts: '1.2', thread_ts: '1.0' },
    });
    expect(parsed).toEqual({
      text: 'hello',
      from: 'U1',
      threadTs: '1.0',
      echo: false,
    });
  });
});

describe('formatPhoneReply', () => {
  it('strips question forms and appends the studio link', () => {
    const text = formatPhoneReply({
      text: 'Here you go.\n<question-form><legend>Pick one</legend></question-form>',
      studioUrl: 'http://127.0.0.1:17573/projects/p/conversations/c',
    });
    expect(text).toContain('Here you go.');
    expect(text).not.toContain('question-form');
    expect(text).toContain('Open in Open Design: http://127.0.0.1:17573/projects/p/conversations/c');
  });

  it('leaves a fallback when markup was the whole message', () => {
    expect(stripPhoneMarkup('<artifact></artifact>')).toBe('');
    expect(formatPhoneReply({ text: '<artifact></artifact>', failed: true })).toContain('did not finish');
  });
});

describe('phone store and inbound pairing', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates an iMessage channel that pairs on the first inbound code', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const service = createPhoneService({
      dataDir: dir,
      connectors: disconnectedConnectors(),
      inboundUrlFor: (id) => `http://127.0.0.1/api/phone/inbound/${id}`,
    });
    const created = service.createChannel({ kind: 'imessage', ownerUserId: 'user-1' });
    expect(created.status).toBe('pairing');
    expect(created.inboundToken.length).toBeGreaterThan(10);
    expect(created.pairingCode).toMatch(/^OD-/);

    const rejected = service.handleInbound(created.id, created.inboundToken, { text: 'hello', from: '+1' });
    expect(rejected.status).toBe('ignored');

    const paired = service.handleInbound(created.id, created.inboundToken, {
      text: `link ${created.pairingCode}`,
      from: '+1555',
    });
    expect(paired.status).toBe('paired');
    expect(service.listChannels().channels[0]?.status).toBe('active');
    expect(service.listChannels().channels[0]?.boundFrom).toBe('+1555');
    service.stop();
  });

  it('rejects a wrong inbound token', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const service = createPhoneService({
      dataDir: dir,
      connectors: disconnectedConnectors(),
      inboundUrlFor: (id) => `http://127.0.0.1/api/phone/inbound/${id}`,
    });
    const created = service.createChannel({ kind: 'imessage', ownerUserId: 'user-1' });
    expect(() => service.handleInbound(created.id, 'nope', { text: created.pairingCode })).toThrow(/invalid phone inbound token/);
    service.stop();
  });

  it('queues a paired message through the run handler', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const service = createPhoneService({
      dataDir: dir,
      connectors: disconnectedConnectors(),
      inboundUrlFor: (id) => `http://127.0.0.1/api/phone/inbound/${id}`,
    });
    const run = vi.fn(async () => ({
      runId: 'run-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      status: 'succeeded' as const,
      text: 'Made a mock.',
      studioUrl: 'http://studio/p',
    }));
    service.setRunHandler(run);
    const created = service.createChannel({
      kind: 'imessage',
      ownerUserId: 'user-1',
    });
    service.handleInbound(created.id, created.inboundToken, {
      text: created.pairingCode,
      from: '+1555',
    });
    const queued = service.handleInbound(created.id, created.inboundToken, {
      text: 'make a pricing page',
      from: '+1555',
    });
    expect(queued.status).toBe('queued');
    await expect.poll(() => run.mock.calls.length).toBe(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      channelId: created.id,
      prompt: 'make a pricing page',
      sourceLabel: 'iMessage',
    }));
    service.stop();
  });

  it('persists channels under the daemon data root', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = createPhoneStore(dir);
    const created = store.create({ kind: 'imessage', ownerUserId: 'u' });
    const reopened = createPhoneStore(dir);
    expect(reopened.get(created.record.id)?.inboundTokenHash).toBe(created.record.inboundTokenHash);
  });
});
