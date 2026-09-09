// VAPID key material and Web Push delivery. Keys prefer OD_VAPID_* env,
// otherwise they persist under the daemon data root so a restart keeps the
// same applicationServerKey the browsers already subscribed with.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import type { ChatPushPayload } from '@open-design/contracts';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSendTarget {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSendResult = 'delivered' | 'gone' | 'failed';

export interface WebPushSender {
  send(target: PushSendTarget, payload: string, vapid: VapidKeys): Promise<PushSendResult>;
}

const VAPID_FILE = 'vapid.json';

function envKeys(env: NodeJS.ProcessEnv): VapidKeys | null {
  const publicKey = env.OD_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.OD_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: vapidSubject(env) };
}

function vapidSubject(env: NodeJS.ProcessEnv): string {
  const explicit = env.OD_VAPID_SUBJECT?.trim();
  if (explicit && /^(mailto:|https?:\/\/)/i.test(explicit)) return explicit;
  // Push services accept a `mailto:` or an `https:` contact and reject
  // anything else, so a plain-http base URL (a LAN deployment, a local
  // tunnel) must fall through to the mailto default rather than become a
  // subject that fails at send time.
  const publicBase = env.OD_PUBLIC_BASE_URL?.trim();
  if (publicBase && /^https:\/\//i.test(publicBase)) {
    return publicBase.replace(/\/+$/u, '');
  }
  return 'mailto:notifications@localhost';
}

async function loadOrCreateKeys(dataDir: string, env: NodeJS.ProcessEnv): Promise<VapidKeys> {
  const fromEnv = envKeys(env);
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, VAPID_FILE);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<VapidKeys>;
    if (
      typeof parsed.publicKey === 'string'
      && parsed.publicKey
      && typeof parsed.privateKey === 'string'
      && parsed.privateKey
    ) {
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        subject: typeof parsed.subject === 'string' && parsed.subject
          ? parsed.subject
          : vapidSubject(env),
      };
    }
  } catch {
    // Missing or unreadable — generate below.
  }
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: vapidSubject(env),
  };
  await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return keys;
}

const defaultSender: WebPushSender = {
  async send(target, payload, vapid) {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        payload,
        {
          vapidDetails: {
            subject: vapid.subject,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          TTL: 60 * 60 * 12,
          urgency: 'high',
        },
      );
      return 'delivered';
    } catch (err) {
      const status = Number((err as { statusCode?: number }).statusCode ?? 0);
      if (status === 404 || status === 410) return 'gone';
      return 'failed';
    }
  },
};

export interface WebPushService {
  publicKey(): Promise<string | null>;
  send(target: PushSendTarget, payload: ChatPushPayload | Record<string, unknown>): Promise<PushSendResult>;
}

export function createWebPushService(opts: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  sender?: WebPushSender;
}): WebPushService {
  const env = opts.env ?? process.env;
  const sender = opts.sender ?? defaultSender;
  let cached: Promise<VapidKeys> | null = null;

  function keys(): Promise<VapidKeys> {
    // Memoize the success, never the failure. `cached ??= load()` kept a
    // rejected promise, so a single unwritable data directory — a slow mount,
    // a transient EPERM — left push dead until the daemon restarted, with
    // every later call re-reading the same stale rejection.
    cached ??= loadOrCreateKeys(opts.dataDir, env).catch((err) => {
      cached = null;
      throw err;
    });
    return cached;
  }

  return {
    async publicKey() {
      try {
        return (await keys()).publicKey;
      } catch {
        return null;
      }
    },
    async send(target, payload) {
      try {
        const vapid = await keys();
        return await sender.send(target, JSON.stringify(payload), vapid);
      } catch {
        return 'failed';
      }
    },
  };
}
