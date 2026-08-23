// Organization Gmail client over HTTP.
//
// Same membership scoping as calendar / pages. The mailbox is live Gmail via
// Composio — nothing is stored in the org database.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  type ModifyMailRequest,
  type ReplyMailRequest,
  type SendMailRequest,
} from '@open-design/contracts';
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
  createGmailExecutor,
  fetchMailProfile,
  getMailThread,
  GMAIL_CONNECTOR_ID,
  listMailLabels,
  listMailMessages,
  modifyMailMessage,
  parseAddressList,
  replyToThread,
  sendMail,
  trashMailMessage,
} from '../workspace-data/mail.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface MailRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  connectors: ConnectorService;
}

export interface RegisterMailRoutesDeps extends RouteDeps<'db' | 'auth'> {
  mail: MailRouteServices;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, `${label} is required`);
  }
  return value as Record<string, unknown>;
}

function asSendBody(value: unknown): SendMailRequest {
  const body = asObject(value, 'request body');
  const to = parseAddressList(body.to);
  return {
    to,
    cc: parseAddressList(body.cc),
    bcc: parseAddressList(body.bcc),
    subject: typeof body.subject === 'string' ? body.subject : '',
    body: typeof body.body === 'string' ? body.body : '',
    isHtml: body.isHtml === true,
  };
}

function asReplyBody(value: unknown): ReplyMailRequest {
  const body = asObject(value, 'request body');
  return {
    to: parseAddressList(body.to),
    cc: parseAddressList(body.cc),
    bcc: parseAddressList(body.bcc),
    body: typeof body.body === 'string' ? body.body : '',
    isHtml: body.isHtml === true,
  };
}

function asModifyBody(value: unknown): ModifyMailRequest {
  const body = asObject(value, 'request body');
  const next: ModifyMailRequest = {};
  if (Array.isArray(body.addLabelIds)) {
    next.addLabelIds = body.addLabelIds.filter((item): item is string => typeof item === 'string');
  }
  if (Array.isArray(body.removeLabelIds)) {
    next.removeLabelIds = body.removeLabelIds.filter((item): item is string => typeof item === 'string');
  }
  return next;
}

export function registerMailRoutes(app: Express, ctx: RegisterMailRoutesDeps) {
  const { manager, identity, connectors } = ctx.mail;
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

  function gmailConnected(): boolean {
    try {
      return Boolean(connectors.getCredential(GMAIL_CONNECTOR_ID)?.credentials);
    } catch {
      return false;
    }
  }

  function requireExecutor() {
    if (!gmailConnected()) {
      throw new WorkspaceDataError(
        'CONNECTOR_NOT_CONNECTED',
        400,
        'Connect Gmail under Integrations first',
      );
    }
    const credentials = connectors.getCredential(GMAIL_CONNECTOR_ID)?.credentials;
    return createGmailExecutor(credentials);
  }

  app.get(
    '/api/orgs/:orgId/mail/status',
    handle(async (req, res) => {
      await scope(req);
      if (!gmailConnected()) {
        res.json({ connected: false, profile: null, labels: [] });
        return;
      }
      const exec = requireExecutor();
      const [profile, labels] = await Promise.all([
        fetchMailProfile(exec),
        listMailLabels(exec).catch(() => []),
      ]);
      res.json({ connected: true, profile, labels });
    }),
  );

  app.get(
    '/api/orgs/:orgId/mail/messages',
    handle(async (req, res) => {
      await scope(req);
      if (!gmailConnected()) {
        res.json({
          connected: false,
          profile: null,
          messages: [],
          nextPageToken: null,
          resultSizeEstimate: null,
        });
        return;
      }
      const exec = requireExecutor();
      const listed = await listMailMessages(exec, {
        ...(typeof req.query.label === 'string' ? { labelIds: [req.query.label] } : {}),
        ...(typeof req.query.q === 'string' ? { query: req.query.q } : {}),
        ...(typeof req.query.pageToken === 'string' ? { pageToken: req.query.pageToken } : {}),
        ...(typeof req.query.maxResults === 'string' && Number.isFinite(Number(req.query.maxResults))
          ? { maxResults: Number(req.query.maxResults) }
          : {}),
      });
      res.json({
        connected: true,
        profile: await fetchMailProfile(exec),
        ...listed,
      });
    }),
  );

  app.get(
    '/api/orgs/:orgId/mail/threads/:threadId',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      const threadId = param(req, 'threadId');
      const messages = await getMailThread(exec, threadId);
      const unread = messages.filter((message) => message.unread);
      await Promise.all(unread.slice(0, 5).map((message) =>
        modifyMailMessage(exec, message.id, { removeLabelIds: ['UNREAD'] }).catch(() => undefined),
      ));
      res.json({
        thread: {
          id: threadId,
          messages: messages.map((message) => ({
            ...message,
            unread: false,
            labelIds: message.labelIds.filter((id) => id !== 'UNREAD'),
          })),
        },
      });
    }),
  );

  app.post(
    '/api/orgs/:orgId/mail/send',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      const result = await sendMail(exec, asSendBody(req.body));
      res.status(201).json(result);
    }),
  );

  app.post(
    '/api/orgs/:orgId/mail/threads/:threadId/reply',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      const result = await replyToThread(exec, param(req, 'threadId'), asReplyBody(req.body));
      res.status(201).json(result);
    }),
  );

  app.post(
    '/api/orgs/:orgId/mail/messages/:messageId/modify',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      await modifyMailMessage(exec, param(req, 'messageId'), asModifyBody(req.body));
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/orgs/:orgId/mail/messages/:messageId/trash',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      await trashMailMessage(exec, param(req, 'messageId'));
      res.status(204).end();
    }),
  );
}
