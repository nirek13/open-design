// Organization Slack client over HTTP.
//
// Same membership scoping as mail / calendar. The workspace is live Slack via
// Composio — nothing is stored in the org database.

import type { Express, Request as ExpressRequest, Response } from 'express';
import { createApiError, type SendSlackMessageRequest } from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import type { ConnectorService } from '../connectors/service.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
} from '../workspace-data/tenancy.js';
import {
  createSlackExecutor,
  fetchSlackProfile,
  getSlackThread,
  listSlackChannels,
  listSlackMessages,
  listSlackUsers,
  reactToSlackMessage,
  searchSlackMessages,
  sendSlackMessage,
  SLACK_CONNECTOR_ID,
} from '../workspace-data/slack.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface SlackRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  connectors: ConnectorService;
}

export interface RegisterSlackRoutesDeps extends RouteDeps<'db' | 'auth'> {
  slack: SlackRouteServices;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, `${label} is required`);
  }
  return value as Record<string, unknown>;
}

function asSendBody(value: unknown): SendSlackMessageRequest {
  const body = asObject(value, 'request body');
  return {
    channelId: typeof body.channelId === 'string' ? body.channelId : '',
    text: typeof body.text === 'string' ? body.text : '',
    ...(typeof body.threadTs === 'string' ? { threadTs: body.threadTs } : {}),
  };
}

export function registerSlackRoutes(app: Express, ctx: RegisterSlackRoutesDeps) {
  const { manager, identity, connectors } = ctx.slack;
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

  async function scope(req: Request, minimum: 'member' | 'admin' | 'owner' = 'member') {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    await getOrganization(directory(), orgId);
    assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );
    return { orgId };
  }

  function slackConnected(): boolean {
    try {
      return Boolean(connectors.getCredential(SLACK_CONNECTOR_ID)?.credentials);
    } catch {
      return false;
    }
  }

  function requireExecutor() {
    if (!slackConnected()) {
      throw new WorkspaceDataError(
        'CONNECTOR_NOT_CONNECTED',
        400,
        'Connect Slack under Integrations first',
      );
    }
    const credentials = connectors.getCredential(SLACK_CONNECTOR_ID)?.credentials;
    return createSlackExecutor(credentials);
  }

  app.get(
    '/api/orgs/:orgId/slack/status',
    handle(async (req, res) => {
      await scope(req);
      if (!slackConnected()) {
        res.json({ connected: false, profile: null });
        return;
      }
      res.json({ connected: true, profile: await fetchSlackProfile(requireExecutor()) });
    }),
  );

  app.get(
    '/api/orgs/:orgId/slack/channels',
    handle(async (req, res) => {
      await scope(req);
      if (!slackConnected()) {
        res.json({ connected: false, channels: [], users: [] });
        return;
      }
      const exec = requireExecutor();
      const [channels, users] = await Promise.all([listSlackChannels(exec), listSlackUsers(exec)]);
      res.json({ connected: true, channels, users });
    }),
  );

  app.get(
    '/api/orgs/:orgId/slack/channels/:channelId/messages',
    handle(async (req, res) => {
      await scope(req);
      if (!slackConnected()) {
        res.json({ connected: false, channel: null, messages: [], cursor: null });
        return;
      }
      const exec = requireExecutor();
      const channelId = param(req, 'channelId');
      const listed = await listSlackMessages(exec, channelId, {
        ...(typeof req.query.cursor === 'string' ? { cursor: req.query.cursor } : {}),
        ...(typeof req.query.limit === 'string' && Number.isFinite(Number(req.query.limit))
          ? { limit: Number(req.query.limit) }
          : {}),
      });
      const channels = await listSlackChannels(exec).catch(() => []);
      res.json({
        connected: true,
        channel: channels.find((channel) => channel.id === channelId) ?? {
          id: channelId,
          name: channelId,
          isPrivate: false,
          isIm: false,
          isMpim: false,
          memberCount: null,
          topic: null,
          purpose: null,
        },
        ...listed,
      });
    }),
  );

  app.get(
    '/api/orgs/:orgId/slack/search',
    handle(async (req, res) => {
      await scope(req);
      if (!slackConnected()) {
        res.json({ connected: false, messages: [] });
        return;
      }
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      res.json({ connected: true, messages: await searchSlackMessages(requireExecutor(), query) });
    }),
  );

  app.get(
    '/api/orgs/:orgId/slack/channels/:channelId/threads/:threadTs',
    handle(async (req, res) => {
      await scope(req);
      res.json({
        messages: await getSlackThread(requireExecutor(), param(req, 'channelId'), param(req, 'threadTs')),
      });
    }),
  );

  app.post(
    '/api/orgs/:orgId/slack/messages',
    handle(async (req, res) => {
      await scope(req);
      res.status(201).json(await sendSlackMessage(requireExecutor(), asSendBody(req.body)));
    }),
  );

  app.post(
    '/api/orgs/:orgId/slack/reactions',
    handle(async (req, res) => {
      await scope(req);
      const body = asObject(req.body, 'request body');
      await reactToSlackMessage(
        requireExecutor(),
        typeof body.channelId === 'string' ? body.channelId : '',
        typeof body.ts === 'string' ? body.ts : '',
        typeof body.emoji === 'string' ? body.emoji : '',
      );
      res.json({ ok: true });
    }),
  );
}
