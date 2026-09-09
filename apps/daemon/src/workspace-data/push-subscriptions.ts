// Per-user Web Push subscriptions. Lives in the directory database because
// identity is a person, not an organization: one browser grant covers every
// org the caller belongs to.

import { randomUUID } from 'node:crypto';
import type { PushSubscriptionJSON } from '@open-design/contracts';
import type { SqlExecutor } from '../storage/sql.js';

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
  createdAt: number;
  updatedAt: number;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export async function upsertPushSubscription(
  directory: SqlExecutor,
  userId: string,
  input: PushSubscriptionJSON,
  userAgent?: string | null,
): Promise<StoredPushSubscription> {
  const existing = await directory.get<{ id: string; createdAt: number | string }>(
    'SELECT id, created_at AS "createdAt" FROM od_push_subscriptions WHERE endpoint = ?',
    [input.endpoint],
  );
  const now = Date.now();
  const agent = userAgent?.trim() ? userAgent.trim().slice(0, 512) : null;
  if (existing) {
    await directory.run(
      `UPDATE od_push_subscriptions
          SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?, updated_at = ?
        WHERE id = ?`,
      [userId, input.keys.p256dh, input.keys.auth, agent, now, existing.id],
    );
    return {
      id: existing.id,
      userId,
      endpoint: input.endpoint,
      keys: input.keys,
      userAgent: agent,
      createdAt: num(existing.createdAt),
      updatedAt: now,
    };
  }
  const id = `push-${randomUUID()}`;
  await directory.run(
    `INSERT INTO od_push_subscriptions
       (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, input.endpoint, input.keys.p256dh, input.keys.auth, agent, now, now],
  );
  return {
    id,
    userId,
    endpoint: input.endpoint,
    keys: input.keys,
    userAgent: agent,
    createdAt: now,
    updatedAt: now,
  };
}

export async function deletePushSubscriptionByEndpoint(
  directory: SqlExecutor,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const existing = await directory.get<{ id: string }>(
    'SELECT id FROM od_push_subscriptions WHERE endpoint = ? AND user_id = ?',
    [endpoint, userId],
  );
  if (!existing) return false;
  await directory.run('DELETE FROM od_push_subscriptions WHERE id = ?', [existing.id]);
  return true;
}

export async function deletePushSubscriptionById(directory: SqlExecutor, id: string): Promise<void> {
  await directory.run('DELETE FROM od_push_subscriptions WHERE id = ?', [id]);
}

export async function listPushSubscriptionsForUser(
  directory: SqlExecutor,
  userId: string,
): Promise<StoredPushSubscription[]> {
  const rows = await directory.all<{
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    createdAt: number | string;
    updatedAt: number | string;
  }>(
    `SELECT id, user_id AS "userId", endpoint, p256dh, auth,
            user_agent AS "userAgent", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM od_push_subscriptions
      WHERE user_id = ?`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    userAgent: row.userAgent,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  }));
}

export async function countPushSubscriptionsForUser(
  directory: SqlExecutor,
  userId: string,
): Promise<number> {
  const row = await directory.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM od_push_subscriptions WHERE user_id = ?',
    [userId],
  );
  return num(row?.n ?? 0);
}

export async function listPushSubscriptionsForUsers(
  directory: SqlExecutor,
  userIds: string[],
): Promise<StoredPushSubscription[]> {
  if (userIds.length === 0) return [];
  const unique = [...new Set(userIds)];
  const placeholders = unique.map(() => '?').join(', ');
  const rows = await directory.all<{
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    createdAt: number | string;
    updatedAt: number | string;
  }>(
    `SELECT id, user_id AS "userId", endpoint, p256dh, auth,
            user_agent AS "userAgent", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM od_push_subscriptions
      WHERE user_id IN (${placeholders})`,
    unique,
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    userAgent: row.userAgent,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  }));
}
