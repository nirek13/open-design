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
//
// Agents use /api/tools/team/* with a chat tool token; people use
// /api/orgs/:orgId/chat/*.

import type { Express, Request as ExpressRequest, Response } from 'express';
import multer from 'multer';
import {
  CHAT_FILE_MAX_BYTES,
  LOCAL_OWNER_USER_ID,
  createApiError,
  extractChatMentions,
  parseChatSearchQuery,
  personLabel,
  type PostMessageRequest,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  chatFileContentDisposition,
  readChatFile,
  writeChatFile,
} from '../workspace-data/chat-files.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
  listOrganizationsForUser,
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
  openDirectMessage,
  postMessage,
  searchMessages,
  setUpDefaultChannels,
  toggleReaction,
  totalUnread,
  unarchiveChannel,
  updateChannel,
  inviteChannelMembers,
  type ResolveMemberName,
} from '../workspace-data/chat.js';
import {
  cancelReminder,
  cancelScheduled,
  createBookmark,
  createReminder,
  deleteBookmark,
  deliverDueScheduled,
  getChatStatus,
  listActivity,
  listBookmarks,
  listChannelFiles,
  listChatStatuses,
  listPins,
  listReminders,
  listSaved,
  listScheduled,
  markChannelUnread,
  scheduleMessage,
  setChatStatus,
  togglePin,
  toggleSave,
  updateChannelPrefs,
} from '../workspace-data/chat-messaging.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface TeamChatRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
}

export interface RegisterTeamChatRoutesDeps extends RouteDeps<'db' | 'auth' | 'paths'> {
  chat: TeamChatRouteServices;
}

export function registerTeamChatRoutes(app: Express, ctx: RegisterTeamChatRoutesDeps) {
  const { manager, identity } = ctx.chat;
  const { authorizeToolRequest } = ctx.auth;
  const dataDir = ctx.paths.RUNTIME_DATA_DIR;
  const directory = () => manager.directoryExecutor;
  const fileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHAT_FILE_MAX_BYTES, files: 1 },
  });

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
              personLabel({
                displayName: row.displayName,
                username: row.username,
                email: row.email,
              }),
            ]),
          );
        }
        return resolveMemberName;
      },
    };
  }

  // --- Channels -----------------------------------------------------------

  app.get('/api/orgs/:orgId/chat/channels', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    await deliverDueScheduled(db, orgId, await withNames());
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

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/unarchive', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req, 'admin');
    res.json({ channel: await unarchiveChannel(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.patch('/api/orgs/:orgId/chat/channels/:channelRef/prefs', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({
      channel: await updateChannelPrefs(db, orgId, param(req, 'channelRef'), member.id, req.body ?? {}),
    });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/unread', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : undefined;
    res.json({
      channel: await markChannelUnread(db, orgId, param(req, 'channelRef'), member.id, messageId),
    });
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

  app.post('/api/orgs/:orgId/chat/files', handle(async (req, res) => {
    const { orgId } = await scope(req);
    const file = await new Promise<Express.Multer.File>((resolve, reject) => {
      fileUpload.single('file')(req, res, (err: unknown) => {
        if (err) {
          if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            reject(new WorkspaceDataError('PAYLOAD_TOO_LARGE', 413, 'file must be 25 MB or smaller'));
            return;
          }
          reject(err);
          return;
        }
        if (!req.file) {
          reject(new WorkspaceDataError('VALIDATION_FAILED', 422, 'file is required'));
          return;
        }
        resolve(req.file);
      });
    });
    const attachment = await writeChatFile(
      dataDir,
      orgId,
      file.buffer,
      file.originalname || 'file',
      file.mimetype,
    );
    res.status(201).json({ attachment });
  }));

  app.get('/api/orgs/:orgId/chat/files/:fileId', handle(async (req, res) => {
    await scope(req);
    const stored = await readChatFile(dataDir, param(req, 'orgId'), param(req, 'fileId'));
    if (!stored) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'file not found');
    }
    res.setHeader('Content-Type', stored.mimeType);
    res.setHeader('Content-Disposition', chatFileContentDisposition(stored.mimeType, stored.fileName));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(stored.bytes);
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/messages', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const body = (req.body ?? {}) as PostMessageRequest;
    const sendAt = typeof body.sendAt === 'number' ? body.sendAt : undefined;
    const people = await listOrgMembers(directory(), orgId);
    const mentions = [
      ...new Set([
        ...(Array.isArray(body.mentions) ? body.mentions.filter((id) => typeof id === 'string') : []),
        ...extractChatMentions(String(body.body ?? ''), people),
      ]),
    ];
    if (sendAt && sendAt > Date.now()) {
      const scheduled = await scheduleMessage(db, orgId, param(req, 'channelRef'), member.id, {
        body: String(body.body ?? ''),
        ...(body.attachments ? { attachments: body.attachments } : {}),
        mentions,
        ...(body.parentMessageId ? { parentMessageId: body.parentMessageId } : {}),
        sendAt,
      });
      res.status(201).json({ scheduled });
      return;
    }
    const message = await postMessage(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      { ...body, mentions },
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
    const message = await getMessage(db, param(req, 'messageId'), await withNames(), member.id);
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

  app.post('/api/orgs/:orgId/chat/dms', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const memberIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds.filter((id: unknown) => typeof id === 'string')
      : [];
    const channel = await openDirectMessage(db, orgId, member.id, memberIds, await withNames());
    res.status(201).json({ channel });
  }));

  app.get('/api/orgs/:orgId/chat/search', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const filters = parseChatSearchQuery(q);
    let fromMemberId: string | null = null;
    if (filters.from) {
      const people = await listOrgMembers(directory(), orgId);
      const needle = filters.from.toLowerCase();
      const found = people.find((person) =>
        person.id === filters.from
        || person.username?.toLowerCase() === needle
        || person.displayName?.toLowerCase().replace(/\s+/g, '') === needle,
      );
      fromMemberId = found?.id ?? filters.from;
    }
    res.json({ hits: await searchMessages(db, orgId, member.id, q, await withNames(), fromMemberId) });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/members', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const memberIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds.filter((id: unknown) => typeof id === 'string')
      : [];
    const channel = await inviteChannelMembers(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      memberIds,
    );
    res.json({ channel });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/reactions', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
    const message = await toggleReaction(
      db,
      orgId,
      param(req, 'messageId'),
      member.id,
      emoji,
      await withNames(),
    );
    res.json({ message });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/pin', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    res.json({
      message: await togglePin(db, orgId, param(req, 'messageId'), member.id, await withNames()),
    });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/save', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    res.json({
      message: await toggleSave(db, orgId, param(req, 'messageId'), member.id, await withNames()),
    });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/remind', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    const fireAt = typeof req.body?.fireAt === 'number' ? req.body.fireAt : 0;
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    res.status(201).json({
      reminder: await createReminder(
        db,
        orgId,
        param(req, 'messageId'),
        member.id,
        fireAt,
        note,
        await withNames(),
      ),
    });
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/pins', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    res.json({ pins: await listPins(db, orgId, param(req, 'channelRef'), member.id, await withNames()) });
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/bookmarks', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({ bookmarks: await listBookmarks(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/bookmarks', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.status(201).json({
      bookmark: await createBookmark(db, orgId, param(req, 'channelRef'), member.id, {
        label: String(req.body?.label ?? ''),
        url: String(req.body?.url ?? ''),
        emoji: typeof req.body?.emoji === 'string' ? req.body.emoji : undefined,
      }),
    });
  }));

  app.delete('/api/orgs/:orgId/chat/bookmarks/:bookmarkId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    await deleteBookmark(db, orgId, param(req, 'bookmarkId'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/files', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({ files: await listChannelFiles(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.get('/api/orgs/:orgId/chat/later', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    res.json({ items: await listSaved(db, orgId, member.id, await withNames()) });
  }));

  app.get('/api/orgs/:orgId/chat/activity', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    await deliverDueScheduled(db, orgId, await withNames());
    res.json({ items: await listActivity(db, orgId, member.id, await withNames()) });
  }));

  app.get('/api/orgs/:orgId/chat/reminders', handle(async (req, res) => {
    const { orgId, member, db, withNames } = await scope(req);
    res.json({ reminders: await listReminders(db, orgId, member.id, await withNames()) });
  }));

  app.delete('/api/orgs/:orgId/chat/reminders/:reminderId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    await cancelReminder(db, orgId, param(req, 'reminderId'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/scheduled', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({ messages: await listScheduled(db, orgId, member.id) });
  }));

  app.delete('/api/orgs/:orgId/chat/scheduled/:scheduledId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    await cancelScheduled(db, orgId, param(req, 'scheduledId'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/status', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const memberId = typeof req.query.memberId === 'string' ? req.query.memberId : member.id;
    if (req.query.all === '1') {
      res.json({ statuses: await listChatStatuses(db, orgId) });
      return;
    }
    res.json({ status: await getChatStatus(db, orgId, memberId) });
  }));

  app.put('/api/orgs/:orgId/chat/status', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({
      status: await setChatStatus(db, orgId, member.id, {
        text: req.body?.text,
        emoji: req.body?.emoji,
        expiresAt: req.body?.expiresAt,
      }),
    });
  }));

  // --- Agent tools --------------------------------------------------------

  async function namesFor(orgId: string): Promise<ResolveMemberName> {
    const names = new Map(
      (await listOrgMembers(directory(), orgId)).map((row) => [
        row.id,
        personLabel({
          displayName: row.displayName,
          username: row.username,
          email: row.email,
        }),
      ]),
    );
    return (memberId) => names.get(memberId) ?? null;
  }

  async function toolOrgActor(req: Request) {
    const orgs = await listOrganizationsForUser(directory(), LOCAL_OWNER_USER_ID);
    const orgId = typeof req.body?.orgId === 'string' && req.body.orgId.trim()
      ? req.body.orgId.trim()
      : orgs[0]?.id;
    if (!orgId) throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization to act in');
    await getOrganization(directory(), orgId);
    const local = await getActiveMemberForUser(directory(), orgId, LOCAL_OWNER_USER_ID);
    const people = local ? null : await listOrgMembers(directory(), orgId);
    const member = local ?? people?.find((row) => row.role === 'owner') ?? people?.[0];
    if (!member) {
      throw new WorkspaceDataError('UNAUTHORIZED', 401, 'no organization member to act as');
    }
    return {
      orgId,
      member,
      db: manager.workspaceExecutor(orgId),
      resolveMemberName: await namesFor(orgId),
    };
  }

  function requiredChannelRef(req: Request): string {
    const value = req.body?.channel ?? req.body?.channelRef ?? req.body?.channelId;
    if (typeof value !== 'string' || !value.trim()) {
      throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'channel is required');
    }
    return value.trim();
  }

  app.post(
    '/api/tools/team/channels',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:channels');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      await deliverDueScheduled(db, orgId, resolveMemberName);
      const channels = await listChannels(db, orgId, member.id, {
        includeArchived: req.body?.includeArchived === true,
      });
      res.json({ orgId, channels, totalUnread: await totalUnread(db, orgId, member.id) });
    }),
  );

  app.post(
    '/api/tools/team/members',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:members');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      const channelRef = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
      if (channelRef) {
        const members = await listChannelMembers(db, orgId, channelRef, member.id, resolveMemberName);
        res.json({ orgId, channel: channelRef, members });
        return;
      }
      const people = await listOrgMembers(directory(), orgId);
      res.json({
        orgId,
        members: people.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          username: row.username,
          email: row.email,
          role: row.role,
        })),
      });
    }),
  );

  app.post(
    '/api/tools/team/messages',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:messages');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      const result = await listMessages(
        db,
        orgId,
        requiredChannelRef(req),
        member.id,
        {
          ...(typeof req.body?.before === 'string' ? { before: req.body.before } : {}),
          ...(typeof req.body?.parentMessageId === 'string'
            ? { parentMessageId: req.body.parentMessageId }
            : {}),
          ...(typeof req.body?.limit === 'number' ? { limit: req.body.limit } : {}),
        },
        resolveMemberName,
      );
      res.json({ orgId, ...result });
    }),
  );

  app.post(
    '/api/tools/team/dm',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:dm');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      const memberIds = Array.isArray(req.body?.memberIds)
        ? req.body.memberIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        : typeof req.body?.member === 'string'
          ? req.body.member.split(',').map((id: string) => id.trim()).filter(Boolean)
          : [];
      const channel = await openDirectMessage(db, orgId, member.id, memberIds, resolveMemberName);
      res.status(201).json({ orgId, channel });
    }),
  );

  app.post(
    '/api/tools/team/post',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:post');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      const people = await listOrgMembers(directory(), orgId);
      const body = (req.body ?? {}) as PostMessageRequest;
      const mentions = [
        ...new Set([
          ...(Array.isArray(body.mentions) ? body.mentions.filter((id) => typeof id === 'string') : []),
          ...extractChatMentions(String(body.body ?? ''), people),
        ]),
      ];
      const message = await postMessage(
        db,
        orgId,
        requiredChannelRef(req),
        member.id,
        { ...body, mentions },
        resolveMemberName,
      );
      res.status(201).json({ orgId, message });
    }),
  );
}
