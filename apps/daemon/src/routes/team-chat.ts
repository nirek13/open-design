// Team chat over HTTP.
//
// Same scoping as the rest of the organization surface: resolve the viewer,
// check membership, then act. Two things worth stating once:
//
//   - Display names are resolved here, not in the chat module. Chat lives in
//     the per-organization database; members and users live in the directory
//     database, and there is no join across those files. The route layer holds
//     both, so it passes a resolver down — the same arrangement the app gallery
//     uses for its byline.
//   - A private channel the caller is not in returns 404, never 403. A 403
//     would confirm that #board-comp exists.

import type { Express, Request as ExpressRequest, Response } from 'express';
import { createApiError, type PostMessageRequest } from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
  listOrgMembers,
} from '../workspace-data/tenancy.js';
import {
  archiveChannel,
  createChannel,
  deleteMessage,
  editMessage,
  getChannel,
  getMessage,
  joinChannel,
  leaveChannel,
  listChannelMembers,
  listChannels,
  listMessages,
  markChannelRead,
  postMessage,
  setUpDefaultChannels,
  totalUnread,
  updateChannel,
  type ResolveMemberName,
} from '../workspace-data/chat.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface TeamChatRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
}

export interface RegisterTeamChatRoutesDeps extends RouteDeps<'db' | 'auth'> {
  chat: TeamChatRouteServices;
}

export function registerTeamChatRoutes(app: Express, ctx: RegisterTeamChatRoutesDeps) {
  const { manager, identity } = ctx.chat;
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
    sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as any)?.message ?? err)));
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

  /** Resolve caller, organization, chat store, and a name resolver. The member
   * list is read once per request and closed over, so rendering 50 messages
   * costs one directory query rather than 50. */
  async function scope(req: Request, minimum: 'member' | 'admin' | 'owner' = 'member') {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );
    let names: Map<string, string> | null = null;
    const resolveMemberName: ResolveMemberName = (memberId) => names?.get(memberId) ?? null;
    return {
      orgId,
      member,
      db: manager.workspaceExecutor(orgId),
      resolveMemberName,
      /** Load the directory's member names. Called only by routes that render
       * people, so a mark-read call does not pay for it. */
      async withNames() {
        if (!names) {
          names = new Map(
            (await listOrgMembers(directory(), orgId)).map((row) => [
              row.id,
              row.displayName || row.email || row.userId,
            ]),
          );
        }
        return resolveMemberName;
      },
    };
  }

  // --- Channels -----------------------------------------------------------

  app.get('/api/orgs/:orgId/chat/channels', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const channels = await listChannels(db, orgId, member.id, {
      includeArchived: req.query.includeArchived === '1',
    });
    res.json({ channels, totalUnread: await totalUnread(db, orgId, member.id) });
  }));

  app.post('/api/orgs/:orgId/chat/channels', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const channel = await createChannel(db, orgId, member.id, req.body ?? {});
    res.status(201).json({ channel });
  }));

  /** Create the starting channels. Idempotent, so the UI can call it the first
   * time someone opens chat without checking first. */
  app.post('/api/orgs/:orgId/chat/setup', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const created = await setUpDefaultChannels(db, orgId, member.id);
    res.status(201).json({ channels: created });
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({ channel: await getChannel(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.patch('/api/orgs/:orgId/chat/channels/:channelRef', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const channel = await updateChannel(db, orgId, param(req, 'channelRef'), member.id, req.body ?? {});
    res.json({ channel });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/archive', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req, 'admin');
    res.json({ channel: await archiveChannel(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/join', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({ channel: await joinChannel(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/leave', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    await leaveChannel(db, orgId, param(req, 'channelRef'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/members', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const members = await listChannelMembers(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      await withNames(),
    );
    res.json({ members });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/read', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const readAt = typeof req.body?.readAt === 'number' ? req.body.readAt : undefined;
    res.json({ channel: await markChannelRead(db, orgId, param(req, 'channelRef'), member.id, readAt) });
  }));

  // --- Messages -----------------------------------------------------------

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/messages', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const result = await listMessages(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      {
        ...(typeof req.query.before === 'string' ? { before: req.query.before } : {}),
        ...(typeof req.query.parentMessageId === 'string'
          ? { parentMessageId: req.query.parentMessageId }
          : {}),
        ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      },
      await withNames(),
    );
    res.json(result);
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/messages', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const message = await postMessage(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      (req.body ?? {}) as PostMessageRequest,
      await withNames(),
    );
    res.status(201).json({ message });
  }));

  /** One message. Exists so a caller holding only a message id can find its
   * channel — replying to `msg-…` should not require also knowing where it
   * was said. Access is checked through the channel, so a message in a private
   * channel the caller cannot see reads as missing. */
  app.get('/api/orgs/:orgId/chat/messages/:messageId', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const message = await getMessage(db, param(req, 'messageId'), await withNames());
    if (message.orgId !== orgId) {
      throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
    }
    await getChannel(db, orgId, message.channelId, member.id);
    res.json({ message });
  }));

  app.patch('/api/orgs/:orgId/chat/messages/:messageId', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const message = await editMessage(
      db,
      orgId,
      param(req, 'messageId'),
      member.id,
      String(req.body?.body ?? ''),
      await withNames(),
    );
    res.json({ message });
  }));

  app.delete('/api/orgs/:orgId/chat/messages/:messageId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    // Admins can remove anyone's message; everyone else only their own. The
    // role check happens here rather than in the chat module because roles are
    // an organization concept, not a chat one.
    const force = member.role === 'owner' || member.role === 'admin';
    await deleteMessage(db, orgId, param(req, 'messageId'), member.id, { force });
    res.status(204).end();
  }));
}
