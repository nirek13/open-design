import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_OWNER_USER_ID } from '@open-design/contracts';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import {
  countPushSubscriptionsForUser,
  deletePushSubscriptionByEndpoint,
  upsertPushSubscription,
} from '../src/workspace-data/push-subscriptions.js';
import { createWebPushService } from '../src/services/web-push.js';

describe('push subscriptions', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-push-sub-'));
    manager = new WorkspaceDbManager(tempDir);
    await ensureDefaultOrganization(manager.directoryExecutor);
  });

  afterEach(() => {
    manager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts by endpoint and counts per user', async () => {
    const directory = manager.directoryExecutor;
    const first = await upsertPushSubscription(directory, LOCAL_OWNER_USER_ID, {
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'one', auth: 'auth' },
    });
    const second = await upsertPushSubscription(directory, LOCAL_OWNER_USER_ID, {
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'two', auth: 'auth2' },
    });
    expect(second.id).toBe(first.id);
    expect(await countPushSubscriptionsForUser(directory, LOCAL_OWNER_USER_ID)).toBe(1);
    expect(await deletePushSubscriptionByEndpoint(directory, LOCAL_OWNER_USER_ID, 'https://push.example/a')).toBe(true);
    expect(await countPushSubscriptionsForUser(directory, LOCAL_OWNER_USER_ID)).toBe(0);
  });
});

describe('web push VAPID keys', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-vapid-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists generated keys under the daemon data root', async () => {
    const service = createWebPushService({ dataDir: tempDir, env: {} });
    const key = await service.publicKey();
    expect(key).toBeTruthy();
    const stored = JSON.parse(readFileSync(path.join(tempDir, 'vapid.json'), 'utf8')) as { publicKey: string };
    expect(stored.publicKey).toBe(key);
    const again = createWebPushService({ dataDir: tempDir, env: {} });
    expect(await again.publicKey()).toBe(key);
  });

  it('prefers OD_VAPID_* over the generated file', async () => {
    const service = createWebPushService({
      dataDir: tempDir,
      env: {
        OD_VAPID_PUBLIC_KEY: 'env-public',
        OD_VAPID_PRIVATE_KEY: 'env-private',
      },
    });
    expect(await service.publicKey()).toBe('env-public');
  });
});
