import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { PhoneChannel, PhoneChannelKind, PhoneChannelStatus } from '@open-design/contracts';

import { generateInboundToken, generatePairingCode, hashPhoneToken } from './tokens.js';

export interface PhoneChannelRecord {
  id: string;
  kind: PhoneChannelKind;
  label: string;
  status: PhoneChannelStatus;
  pairingCode: string | null;
  inboundTokenHash: string;
  slackChannelId: string | null;
  slackChannelName: string | null;
  replyUrl: string | null;
  replyToken: string | null;
  boundFrom: string | null;
  projectId: string | null;
  conversationId: string | null;
  lastInboundAt: string | null;
  lastSlackTs: string | null;
  lastOutboundTs: string | null;
  busyRunId: string | null;
  lastError: string | null;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PhoneStoreFile {
  schemaVersion: 1;
  channels: PhoneChannelRecord[];
}

export function phoneStorePath(dataDir: string): string {
  return path.join(dataDir, 'phone', 'channels.json');
}

export function createPhoneStore(dataDir: string) {
  const filePath = phoneStorePath(dataDir);

  function readFile(): PhoneStoreFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { schemaVersion: 1, channels: [] };
      }
      const rec = parsed as Record<string, unknown>;
      const channels = Array.isArray(rec.channels)
        ? rec.channels.filter((item): item is PhoneChannelRecord => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            const row = item as PhoneChannelRecord;
            return typeof row.id === 'string' && (row.kind === 'slack' || row.kind === 'imessage');
          })
        : [];
      return { schemaVersion: 1, channels };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { schemaVersion: 1, channels: [] };
      }
      throw error;
    }
  }

  function writeFile(next: PhoneStoreFile): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  function list(): PhoneChannelRecord[] {
    return readFile().channels;
  }

  function get(id: string): PhoneChannelRecord | null {
    return list().find((channel) => channel.id === id) ?? null;
  }

  function save(record: PhoneChannelRecord): PhoneChannelRecord {
    const file = readFile();
    const index = file.channels.findIndex((channel) => channel.id === record.id);
    const next = { ...record, updatedAt: new Date().toISOString() };
    if (index >= 0) file.channels[index] = next;
    else file.channels.push(next);
    writeFile(file);
    return next;
  }

  function remove(id: string): boolean {
    const file = readFile();
    const next = file.channels.filter((channel) => channel.id !== id);
    if (next.length === file.channels.length) return false;
    writeFile({ ...file, channels: next });
    return true;
  }

  function create(input: {
    kind: PhoneChannelKind;
    ownerUserId: string;
    label?: string;
    slackChannelId?: string;
    slackChannelName?: string;
    replyUrl?: string;
    replyToken?: string;
  }): { record: PhoneChannelRecord; inboundToken: string } {
    const inboundToken = generateInboundToken();
    const now = new Date().toISOString();
    const slackReady = input.kind === 'slack' && Boolean(input.slackChannelId?.trim());
    const record: PhoneChannelRecord = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label?.trim()
        || (input.kind === 'slack'
          ? (input.slackChannelName?.trim() || 'Slack')
          : 'iMessage'),
      status: slackReady ? 'active' : 'pairing',
      pairingCode: slackReady ? null : generatePairingCode(),
      inboundTokenHash: hashPhoneToken(inboundToken),
      slackChannelId: input.slackChannelId?.trim() || null,
      slackChannelName: input.slackChannelName?.trim() || null,
      replyUrl: input.replyUrl?.trim() || null,
      replyToken: input.replyToken?.trim() || null,
      boundFrom: null,
      projectId: null,
      conversationId: null,
      lastInboundAt: null,
      lastSlackTs: null,
      lastOutboundTs: null,
      busyRunId: null,
      lastError: null,
      ownerUserId: input.ownerUserId,
      createdAt: now,
      updatedAt: now,
    };
    save(record);
    return { record, inboundToken };
  }

  function rotateToken(id: string): { record: PhoneChannelRecord; inboundToken: string } | null {
    const existing = get(id);
    if (!existing) return null;
    const inboundToken = generateInboundToken();
    const record = save({ ...existing, inboundTokenHash: hashPhoneToken(inboundToken) });
    return { record, inboundToken };
  }

  return { list, get, save, remove, create, rotateToken, filePath };
}

export type PhoneStore = ReturnType<typeof createPhoneStore>;

export function toPublicPhoneChannel(record: PhoneChannelRecord, inboundUrl: string): PhoneChannel {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    status: record.status,
    pairingCode: record.status === 'pairing' ? record.pairingCode : null,
    inboundUrl,
    slackChannelId: record.slackChannelId,
    slackChannelName: record.slackChannelName,
    replyUrl: record.replyUrl,
    boundFrom: record.boundFrom,
    projectId: record.projectId,
    conversationId: record.conversationId,
    lastInboundAt: record.lastInboundAt,
    lastError: record.lastError,
    createdAt: record.createdAt,
  };
}
