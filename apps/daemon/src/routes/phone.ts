import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import { PhoneServiceError, type PhoneService } from '../phone/service.js';
import {
  listSlackChannels,
  createSlackExecutor,
  SLACK_CONNECTOR_ID,
} from '../workspace-data/slack.js';
import type { ConnectorService } from '../connectors/service.js';

type Request = ExpressRequest<Record<string, string>>;

export interface RegisterPhoneRoutesDeps extends RouteDeps<'http'> {
  phone: {
    identity: IdentityService;
    service: PhoneService;
    connectors: ConnectorService;
    directory: () => unknown;
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization') ?? req.get('x-od-phone-token') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match?.[1]) return match[1].trim();
  const query = req.query.token;
  return typeof query === 'string' && query.trim() ? query.trim() : null;
}

export function registerPhoneRoutes(app: Express, ctx: RegisterPhoneRoutesDeps): void {
  const { sendApiError: sendErr } = ctx.http;
  const { identity, service, connectors, directory } = ctx.phone;

  function fail(res: Response, err: unknown): void {
    if (err instanceof PhoneServiceError) {
      sendErr(res, err.status, createApiError(err.code, err.message));
      return;
    }
    sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as Error)?.message ?? err)));
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

  async function requireViewer(req: Request) {
    const viewer = await identity.resolveViewer(req, directory() as never);
    if (!viewer) {
      throw new PhoneServiceError('UNAUTHORIZED', 401, 'sign in to continue');
    }
    return viewer;
  }

  app.get(
    '/api/phone/channels',
    handle(async (req, res) => {
      await requireViewer(req);
      res.json(service.listChannels());
    }),
  );

  app.get(
    '/api/phone/slack-channels',
    handle(async (req, res) => {
      await requireViewer(req);
      if (!service.slackConnected()) {
        res.json({ connected: false, channels: [] });
        return;
      }
      const credentials = connectors.getCredential(SLACK_CONNECTOR_ID)?.credentials;
      const channels = await listSlackChannels(createSlackExecutor(credentials));
      res.json({ connected: true, channels });
    }),
  );

  app.post(
    '/api/phone/channels',
    handle(async (req, res) => {
      const viewer = await requireViewer(req);
      const body = asObject(req.body);
      const kind = body.kind;
      if (kind !== 'slack' && kind !== 'imessage') {
        throw new PhoneServiceError('VALIDATION_FAILED', 422, 'kind must be slack or imessage');
      }
      const created = service.createChannel({
        kind,
        ownerUserId: viewer.userId,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.slackChannelId === 'string' ? { slackChannelId: body.slackChannelId } : {}),
        ...(typeof body.slackChannelName === 'string' ? { slackChannelName: body.slackChannelName } : {}),
        ...(typeof body.replyUrl === 'string' ? { replyUrl: body.replyUrl } : {}),
        ...(typeof body.replyToken === 'string' ? { replyToken: body.replyToken } : {}),
      });
      res.status(201).json(created);
    }),
  );

  app.patch(
    '/api/phone/channels/:id',
    handle(async (req, res) => {
      await requireViewer(req);
      const body = asObject(req.body);
      const status = body.status === 'active' || body.status === 'paused' ? body.status : undefined;
      res.json(service.patchChannel(req.params.id ?? '', {
        ...(status ? { status } : {}),
        ...(typeof body.slackChannelId === 'string' ? { slackChannelId: body.slackChannelId } : {}),
        ...(typeof body.slackChannelName === 'string' ? { slackChannelName: body.slackChannelName } : {}),
        ...(body.replyUrl === null || typeof body.replyUrl === 'string' ? { replyUrl: body.replyUrl as string | null } : {}),
        ...(body.replyToken === null || typeof body.replyToken === 'string' ? { replyToken: body.replyToken as string | null } : {}),
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
      }));
    }),
  );

  app.delete(
    '/api/phone/channels/:id',
    handle(async (req, res) => {
      await requireViewer(req);
      service.deleteChannel(req.params.id ?? '');
      res.status(204).end();
    }),
  );

  app.post(
    '/api/phone/channels/:id/rotate-token',
    handle(async (req, res) => {
      await requireViewer(req);
      res.json(service.rotateChannel(req.params.id ?? ''));
    }),
  );

  app.post(
    '/api/phone/inbound/:id',
    handle(async (req, res) => {
      const challenge = service.slackUrlChallenge(req.body);
      if (challenge) {
        res.json({ challenge });
        return;
      }
      const result = service.handleInbound(req.params.id ?? '', bearerToken(req), req.body);
      res.json(result);
    }),
  );
}
