// Web Push subscription HTTP surface.
//
// Browser-only: the service worker and PushManager live in the page. The CLI
// can inspect status and send a test ping to already-registered browsers
// (`od team push-status` / `od team push-test`).

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  parsePushSubscriptionJSON,
  type ChatPushPayload,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  countPushSubscriptionsForUser,
  deletePushSubscriptionById,
  deletePushSubscriptionByEndpoint,
  listPushSubscriptionsForUser,
  upsertPushSubscription,
} from '../workspace-data/push-subscriptions.js';
import type { WebPushService } from '../services/web-push.js';

type Request = ExpressRequest<Record<string, string>>;

export interface RegisterPushRoutesDeps extends RouteDeps<'auth' | 'paths'> {
  push: {
    manager: WorkspaceDbManager;
    identity: IdentityService;
    webPush: WebPushService;
  };
}

export function registerPushRoutes(app: Express, ctx: RegisterPushRoutesDeps) {
  const { manager, identity, webPush } = ctx.push;
  const directory = () => manager.directoryExecutor;

  function fail(res: Response, err: unknown): void {
    if (err instanceof WorkspaceDataError) {
      sendApiError(
        res,
        err.status,
        createApiError(err.code, err.message, err.details === undefined ? {} : { details: err.details }),
      );
      return;
    }
    sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as { message?: string })?.message ?? err)));
  }

  const handle =
    (fn: (req: Request, res: Response) => void | Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };

  async function viewerFor(req: Request) {
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    return viewer;
  }

  app.get('/api/push', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const publicKey = await webPush.publicKey();
    res.json({
      enabled: Boolean(publicKey),
      publicKey,
      subscriptionCount: await countPushSubscriptionsForUser(directory(), viewer.userId),
    });
  }));

  app.put('/api/push/subscriptions', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const publicKey = await webPush.publicKey();
    if (!publicKey) {
      throw new WorkspaceDataError('INTERNAL_ERROR', 503, 'push notifications are not available');
    }
    const parsed = parsePushSubscriptionJSON(req.body?.subscription ?? req.body);
    if (!parsed) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'a valid push subscription is required');
    }
    const userAgent =
      typeof req.body?.userAgent === 'string'
        ? req.body.userAgent
        : typeof req.get('user-agent') === 'string'
          ? req.get('user-agent')
          : null;
    const stored = await upsertPushSubscription(directory(), viewer.userId, parsed, userAgent);
    res.json({ id: stored.id });
  }));

  app.delete('/api/push/subscriptions', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const endpoint =
      typeof req.body?.endpoint === 'string'
        ? req.body.endpoint.trim()
        : typeof req.query.endpoint === 'string'
          ? req.query.endpoint.trim()
          : '';
    if (!endpoint) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'endpoint is required');
    }
    await deletePushSubscriptionByEndpoint(directory(), viewer.userId, endpoint);
    res.status(204).end();
  }));

  app.post('/api/push/test', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const publicKey = await webPush.publicKey();
    if (!publicKey) {
      throw new WorkspaceDataError('INTERNAL_ERROR', 503, 'push notifications are not available');
    }
    const subscriptions = await listPushSubscriptionsForUser(directory(), viewer.userId);
    if (subscriptions.length === 0) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'no push subscription on this account');
    }
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim().slice(0, 80)
      : 'Chat';
    const body = typeof req.body?.body === 'string' && req.body.body.trim()
      ? req.body.body.trim().slice(0, 140)
      : 'Push notifications are on.';
    const payload: ChatPushPayload = {
      type: 'team-chat',
      title,
      body,
      url: '/team',
      tag: 'chat-test',
      orgId: '',
      channelSlug: '',
      messageId: '',
    };
    let delivered = 0;
    await Promise.all(
      subscriptions.map(async (sub) => {
        const result = await webPush.send(sub, payload);
        // A browser that has revoked or reinstalled reports its endpoint as
        // gone. Chat delivery already drops those rows on the way past; the
        // test path is the one place a person deliberately exercises push, so
        // it is the worst place to leave a dead endpoint behind and keep
        // reporting it in `subscriptionCount`.
        if (result === 'gone') {
          await deletePushSubscriptionById(directory(), sub.id);
          return;
        }
        if (result === 'delivered') delivered += 1;
      }),
    );
    res.json({
      delivered,
      subscriptionCount: await countPushSubscriptionsForUser(directory(), viewer.userId),
    });
  }));
}
