// Team chat over HTTP.
//
// Same scoping as the rest of the organization surface: resolve the viewer,
// check membership, then act. The shared parts of that — the scope resolver,
// the error mapping, the rate limiter, and `emit` — live in `chat-context.ts`
// so this file, the realtime stream, and the organization furniture cannot
// drift apart on them.
//
// Three rules worth stating once:
//
//   - Display names are resolved here, not in the chat module. Chat lives in
//     the per-organization database; members and users live in the directory
//     database, and there is no join across those files. The route layer holds
//     both, so it passes a resolver down — the same arrangement the app
//     gallery uses for its byline.
//   - A private channel the caller is not in returns 404, never 403. A 403
//     would confirm that #board-comp exists.
//   - Every write that another person could be looking at ends with an `emit`.
//     That is what makes the client a listener rather than a poller, and it is
//     why the log append happens before the fan-out rather than after.
//
// Agents use /api/tools/team/* with a chat tool token; people use
// /api/orgs/:orgId/chat/*.

import type { Express } from 'express';
import multer from 'multer';
import {
  CHAT_FILE_MAX_BYTES,
  LOCAL_OWNER_USER_ID,
  expandGroupMentions,
  extractChatMentions,
  parseChatSearchQuery,
  personLabel,
  type ChatChannel,
  type PostMessageRequest,
  type TeamChatMessage,
} from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import type { SqlExecutor } from '../storage/sql.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  chatFileContentDisposition,
  readChatFile,
  writeChatFile,
} from '../workspace-data/chat-files.js';
import {
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
  forwardMessage,
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
  unarchiveChannel,
  unreadTotals,
  updateChannel,
  inviteChannelMembers,
  visibleChannelIds,
  type PostMessageOptions,
  type ResolveMemberName,
} from '../workspace-data/chat.js';
import { dispatchChatPush } from '../workspace-data/chat-push.js';
import { listUserGroups, deleteDraft } from '../workspace-data/chat-org.js';
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
import { ChatRealtimeHub } from '../services/chat-realtime.js';
import { ChatMaintenance } from '../services/chat-maintenance.js';
import { CHAT_RATE_RULES, RateLimiter } from '../services/rate-limit.js';
import {
  chatHandler,
  chatParam as param,
  createChatContext,
  type ChatRequest as Request,
  type ChatRouteServices,
} from './chat-context.js';
import { registerChatRealtimeRoutes } from './chat-realtime.js';
import { registerChatOrgRoutes } from './chat-org.js';

export type TeamChatRouteServices = Pick<ChatRouteServices, 'manager' | 'identity' | 'webPush'>;

export interface RegisterTeamChatRoutesDeps extends RouteDeps<'db' | 'auth' | 'paths'> {
  chat: TeamChatRouteServices;
}

export function registerTeamChatRoutes(app: Express, deps: RegisterTeamChatRoutesDeps) {
  const { authorizeToolRequest } = deps.auth;
  const dataDir = deps.paths.RUNTIME_DATA_DIR;
  const { manager } = deps.chat;

  // The hub and the limiter are created here rather than in server.ts because
  // they are chat's own machinery: nothing else subscribes to chat events, and
  // nothing else is limited by chat's rules.
  const hub = new ChatRealtimeHub({
    visibleChannelIds: (orgId, memberId) =>
      visibleChannelIds(manager.workspaceExecutor(orgId), orgId, memberId),
  });
  const limiter = new RateLimiter(CHAT_RATE_RULES);
  const ctx = createChatContext({ ...deps.chat, hub, limiter });
  const directory = () => manager.directoryExecutor;

  // Pruning the event log, expiring messages past their retention, and closing
  // huddles whose last participant's browser crashed. All three are the kind of
  // job that is invisible until it has not run for a month.
  const maintenance = new ChatMaintenance(manager);
  maintenance.start();

  registerChatRealtimeRoutes(app, ctx);
  registerChatOrgRoutes(app, ctx, dataDir);

  const fileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHAT_FILE_MAX_BYTES, files: 1 },
  });

  /** Resolve the mentions in a body once: named people, the special
   * @channel / @here / @everyone tokens, and every member of a named group.
   *
   * Group members are folded into the same `mentions` list rather than kept
   * separate, so the notification path has exactly one list to consult and
   * cannot notify on people mentioned directly while missing people mentioned
   * through a group. The group ids come back too, only so the renderer can
   * show one chip instead of eleven names. */
  async function resolveMentions(
    ctxScope: { orgId: string; db: SqlExecutor; people(): Promise<Array<{ id: string; username?: string | null; displayName?: string | null }>> },
    body: string,
    explicit: unknown,
  ): Promise<{ mentions: string[]; groupMentions: string[] }> {
    const people = await ctxScope.people();
    const groups = await listUserGroups(ctxScope.db, ctxScope.orgId).catch(() => []);
    const expanded = expandGroupMentions(body, groups);
    const mentions = new Set<string>([
      ...(Array.isArray(explicit) ? explicit.filter((id): id is string => typeof id === 'string') : []),
      ...extractChatMentions(body, people),
      ...expanded.memberIds,
    ]);
    return { mentions: [...mentions], groupMentions: expanded.groupIds };
  }

  /** Announce a posted message and push to whoever is not looking at it.
   *
   * Deliberately not awaited by the caller: a mention has already landed in
   * the channel by the time this runs, and a push service that is slow or
   * broken must not hold up the response to the person who sent it. */
  function announcePosted(
    orgId: string,
    db: SqlExecutor,
    actorMemberId: string,
    message: TeamChatMessage,
  ): void {
    ctx.emitSoon(
      orgId,
      { type: 'message-posted', channelId: message.channelId, message },
      { channelId: message.channelId },
    );
    void (async () => {
      try {
        const channel = await getChannel(db, orgId, message.channelId, actorMemberId);
        await dispatchChatPush({
          directory: directory(),
          db,
          orgId,
          channel,
          message,
          webPush: deps.chat.webPush,
        });
      } catch {
        // Push is best-effort; a mention must still land in the channel.
      }
    })();
  }

  async function flushScheduled(
    db: SqlExecutor,
    orgId: string,
    resolveMemberName?: ResolveMemberName,
  ): Promise<void> {
    await deliverDueScheduled(db, orgId, resolveMemberName, (message) => {
      announcePosted(orgId, db, message.authorMemberId ?? '', message);
    });
  }

  /** Tell the room that someone's read marker moved. Ephemeral: it is only
   * interesting while people are looking, and replaying it after a reconnect
   * would say "Ada read this" about a moment that has passed. */
  function announceRead(orgId: string, channel: ChatChannel, memberId: string, lastReadAt: number): void {
    hub.publishEphemeral(
      orgId,
      { type: 'read-marker', channelId: channel.id, memberId, lastReadAt },
      { channelId: channel.id },
    );
  }

  // --- Channels -----------------------------------------------------------

  app.get('/api/orgs/:orgId/chat/channels', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    await flushScheduled(db, orgId, await withNames());
    const channels = await listChannels(db, orgId, member.id, {
      includeArchived: req.query.includeArchived === '1',
    });
    const totals = await unreadTotals(db, orgId, member.id);
    res.json({ channels, totalUnread: totals.unread, totalMentions: totals.mentions });
  }));

  app.post('/api/orgs/:orgId/chat/channels', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const channel = await createChannel(db, orgId, member.id, req.body ?? {});
    // A public channel is news for the whole organization; a private one is
    // news only for the people put in it, and telling anybody else would defeat
    // the point of it being private.
    await ctx.emit(
      orgId,
      { type: 'channel-created', channel },
      channel.visibility === 'private'
        ? { channelId: channel.id, audience: [member.id, ...(req.body?.memberIds ?? [])] }
        : { channelId: null },
    );
    res.status(201).json({ channel });
  }));

  /** Create the starting channels. Idempotent, so the UI can call it the first
   * time someone opens chat without checking first. */
  app.post('/api/orgs/:orgId/chat/setup', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const created = await setUpDefaultChannels(db, orgId, member.id);
    for (const channel of created) {
      await ctx.emit(orgId, { type: 'channel-created', channel }, { channelId: null });
    }
    res.status(201).json({ channels: created });
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    res.json({ channel: await getChannel(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.patch('/api/orgs/:orgId/chat/channels/:channelRef', chatHandler(async (req, res) => {
    const { orgId, member, db, isAdmin } = await ctx.scope(req);
    // Turning a channel into an announcement channel is a permission change,
    // so it takes the role that permission changes take. Renaming it is not.
    if (req.body?.postPolicy !== undefined && !isAdmin) {
      throw new WorkspaceDataError('ORG_ROLE_REQUIRED', 403, 'only admins can change who may post');
    }
    const channel = await updateChannel(db, orgId, param(req, 'channelRef'), member.id, req.body ?? {});
    await ctx.emit(orgId, { type: 'channel-updated', channel }, { channelId: channel.id });
    res.json({ channel });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/archive', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req, 'admin');
    const channel = await archiveChannel(db, orgId, param(req, 'channelRef'), member.id);
    await ctx.emit(
      orgId,
      { type: 'channel-archived', channelId: channel.id, archivedAt: channel.archivedAt ?? Date.now() },
      { channelId: channel.id },
    );
    res.json({ channel });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/unarchive', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req, 'admin');
    const channel = await unarchiveChannel(db, orgId, param(req, 'channelRef'), member.id);
    await ctx.emit(orgId, { type: 'channel-updated', channel }, { channelId: channel.id });
    res.json({ channel });
  }));

  app.patch('/api/orgs/:orgId/chat/channels/:channelRef/prefs', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    res.json({
      channel: await updateChannelPrefs(db, orgId, param(req, 'channelRef'), member.id, req.body ?? {}),
    });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/unread', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : undefined;
    res.json({
      channel: await markChannelUnread(db, orgId, param(req, 'channelRef'), member.id, messageId),
    });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/join', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    const channel = await joinChannel(db, orgId, param(req, 'channelRef'), member.id);
    const members = await listChannelMembers(db, orgId, channel.id, member.id, await withNames());
    const joined = members.find((row) => row.memberId === member.id);
    if (joined) {
      await ctx.emit(orgId, { type: 'member-joined', channelId: channel.id, member: joined }, {
        channelId: channel.id,
      });
    }
    res.json({ channel });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/leave', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const channel = await getChannel(db, orgId, param(req, 'channelRef'), member.id);
    await leaveChannel(db, orgId, param(req, 'channelRef'), member.id);
    await ctx.emit(orgId, { type: 'member-left', channelId: channel.id, memberId: member.id }, {
      channelId: channel.id,
    });
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/members', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    const members = await listChannelMembers(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      await withNames(),
    );
    res.json({ members });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/read', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const readAt = typeof req.body?.readAt === 'number' ? req.body.readAt : undefined;
    const channel = await markChannelRead(db, orgId, param(req, 'channelRef'), member.id, readAt);
    announceRead(orgId, channel, member.id, readAt ?? Date.now());
    res.json({ channel });
  }));

  // --- Messages -----------------------------------------------------------

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/messages', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
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

  app.post('/api/orgs/:orgId/chat/files', chatHandler(async (req, res) => {
    const { orgId, member } = await ctx.scope(req);
    if (!ctx.allow(res, 'chat:upload', `${orgId}:${member.id}`)) return;
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

  app.get('/api/orgs/:orgId/chat/files/:fileId', chatHandler(async (req, res) => {
    await ctx.scope(req);
    const stored = await readChatFile(dataDir, param(req, 'orgId'), param(req, 'fileId'));
    if (!stored) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'file not found');
    }
    res.setHeader('Content-Type', stored.mimeType);
    res.setHeader('Content-Disposition', chatFileContentDisposition(stored.mimeType, stored.fileName));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(stored.bytes);
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/messages', chatHandler(async (req, res) => {
    const scope = await ctx.scope(req);
    const { orgId, member, db, isAdmin, withNames } = scope;
    if (!ctx.allow(res, 'chat:post', `${orgId}:${member.id}`)) return;
    const body = (req.body ?? {}) as PostMessageRequest;
    const sendAt = typeof body.sendAt === 'number' ? body.sendAt : undefined;
    const { mentions, groupMentions } = await resolveMentions(scope, String(body.body ?? ''), body.mentions);

    if (sendAt && sendAt > Date.now()) {
      // An announcement channel is checked here rather than at delivery: this
      // is the last moment there is a caller whose role can be read.
      const target = await getChannel(db, orgId, param(req, 'channelRef'), member.id);
      if (target.postPolicy === 'admins' && !isAdmin && !body.parentMessageId) {
        throw new WorkspaceDataError(
          'CHANNEL_POST_DENIED',
          403,
          `only admins can post to #${target.slug}`,
        );
      }
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

    const options: PostMessageOptions = { isAdmin, groupMentions };
    const message = await postMessage(
      db,
      orgId,
      param(req, 'channelRef'),
      member.id,
      { ...body, mentions },
      await withNames(),
      options,
    );
    // Sending clears the draft and takes the typing indicator down. Both are
    // things the person plainly meant by pressing enter, and leaving either
    // behind reads as a bug.
    await deleteDraft(db, member.id, message.channelId, message.parentMessageId).catch(() => {});
    hub.typing(orgId, message.channelId, member.id, message.parentMessageId, false);
    announcePosted(orgId, db, member.id, message);
    res.status(201).json({ message });
  }));

  /** Forward a message to another channel, quoting what it said at the time.
   * The quote is a snapshot rather than a link: a forward is a claim about
   * what somebody said, and a reference that follows a later edit turns that
   * claim into something they never wrote. */
  app.post('/api/orgs/:orgId/chat/messages/:messageId/forward', chatHandler(async (req, res) => {
    const { orgId, member, db, isAdmin, withNames } = await ctx.scope(req);
    if (!ctx.allow(res, 'chat:post', `${orgId}:${member.id}`)) return;
    const toChannel = String(req.body?.toChannel ?? '');
    if (!toChannel) {
      throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'name a channel to forward to');
    }
    const message = await forwardMessage(
      db,
      orgId,
      param(req, 'messageId'),
      member.id,
      toChannel,
      typeof req.body?.comment === 'string' ? req.body.comment : undefined,
      await withNames(),
      { isAdmin },
    );
    announcePosted(orgId, db, member.id, message);
    res.status(201).json({ message });
  }));

  /** One message. Exists so a caller holding only a message id can find its
   * channel — replying to `msg-…` should not require also knowing where it
   * was said. Access is checked through the channel, so a message in a private
   * channel the caller cannot see reads as missing. */
  app.get('/api/orgs/:orgId/chat/messages/:messageId', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    const message = await getMessage(db, param(req, 'messageId'), await withNames(), member.id);
    if (message.orgId !== orgId) {
      throw new WorkspaceDataError('CHAT_MESSAGE_NOT_FOUND', 404, 'no such message');
    }
    await getChannel(db, orgId, message.channelId, member.id);
    res.json({ message });
  }));

  app.patch('/api/orgs/:orgId/chat/messages/:messageId', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    const message = await editMessage(
      db,
      orgId,
      param(req, 'messageId'),
      member.id,
      String(req.body?.body ?? ''),
      await withNames(),
    );
    await ctx.emit(orgId, { type: 'message-edited', channelId: message.channelId, message }, {
      channelId: message.channelId,
    });
    res.json({ message });
  }));

  app.delete('/api/orgs/:orgId/chat/messages/:messageId', chatHandler(async (req, res) => {
    const { orgId, member, db, isAdmin } = await ctx.scope(req);
    // Admins can remove anyone's message; everyone else only their own. The
    // role check happens here rather than in the chat module because roles are
    // an organization concept, not a chat one.
    const existing = await getMessage(db, param(req, 'messageId'));
    await deleteMessage(db, orgId, param(req, 'messageId'), member.id, { force: isAdmin });
    await ctx.emit(
      orgId,
      { type: 'message-deleted', channelId: existing.channelId, messageId: existing.id },
      { channelId: existing.channelId },
    );
    res.status(204).end();
  }));

  app.post('/api/orgs/:orgId/chat/dms', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    const memberIds = Array.isArray(req.body?.memberIds)
      ? req.body.memberIds.filter((id: unknown) => typeof id === 'string')
      : [];
    const channel = await openDirectMessage(db, orgId, member.id, memberIds, await withNames());
    // Only the people in it hear about a direct message. Announcing it to the
    // organization would turn "who is talking to whom" into public knowledge.
    await ctx.emit(orgId, { type: 'channel-created', channel }, {
      channelId: channel.id,
      audience: [member.id, ...memberIds],
    });
    res.status(201).json({ channel });
  }));

  app.get('/api/orgs/:orgId/chat/search', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames, people } = await ctx.scope(req);
    if (!ctx.allow(res, 'chat:search', `${orgId}:${member.id}`)) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const filters = parseChatSearchQuery(q);
    let fromMemberId: string | null = null;
    if (filters.from) {
      const roster = await people();
      const needle = filters.from.toLowerCase();
      const found = roster.find((person) =>
        person.id === filters.from
        || person.username?.toLowerCase() === needle
        || person.displayName?.toLowerCase().replace(/\s+/g, '') === needle,
      );
      fromMemberId = found?.id ?? filters.from;
    }
    res.json({ hits: await searchMessages(db, orgId, member.id, q, await withNames(), fromMemberId) });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/members', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
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
    const members = await listChannelMembers(db, orgId, channel.id, member.id, await withNames());
    for (const memberId of memberIds) {
      const joined = members.find((row) => row.memberId === memberId);
      if (!joined) continue;
      await ctx.emit(orgId, { type: 'member-joined', channelId: channel.id, member: joined }, {
        channelId: channel.id,
      });
      // Someone added to a private channel has to be told about the channel
      // itself, not just about the membership row — until this arrives, the
      // channel does not exist as far as their client is concerned.
      if (channel.visibility === 'private') {
        await ctx.emit(orgId, { type: 'channel-created', channel }, {
          channelId: channel.id,
          audience: [memberId],
        });
      }
    }
    res.json({ channel });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/reactions', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    if (!ctx.allow(res, 'chat:react', `${orgId}:${member.id}`)) return;
    const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
    const message = await toggleReaction(
      db,
      orgId,
      param(req, 'messageId'),
      member.id,
      emoji,
      await withNames(),
    );
    await ctx.emit(orgId, { type: 'reaction-changed', channelId: message.channelId, message }, {
      channelId: message.channelId,
    });
    res.json({ message });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/pin', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    const message = await togglePin(db, orgId, param(req, 'messageId'), member.id, await withNames());
    await ctx.emit(
      orgId,
      { type: 'pin-changed', channelId: message.channelId, messageId: message.id, pinned: message.pinned },
      { channelId: message.channelId },
    );
    res.json({ message });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/save', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    // Saving is private — nobody else is told, because nobody else is affected.
    res.json({
      message: await toggleSave(db, orgId, param(req, 'messageId'), member.id, await withNames()),
    });
  }));

  app.post('/api/orgs/:orgId/chat/messages/:messageId/remind', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
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

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/pins', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    res.json({ pins: await listPins(db, orgId, param(req, 'channelRef'), member.id, await withNames()) });
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/bookmarks', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    res.json({ bookmarks: await listBookmarks(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.post('/api/orgs/:orgId/chat/channels/:channelRef/bookmarks', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const bookmark = await createBookmark(db, orgId, param(req, 'channelRef'), member.id, {
      label: String(req.body?.label ?? ''),
      url: String(req.body?.url ?? ''),
      emoji: typeof req.body?.emoji === 'string' ? req.body.emoji : undefined,
    });
    await ctx.emit(
      orgId,
      {
        type: 'bookmark-changed',
        channelId: bookmark.channelId,
        bookmarks: await listBookmarks(db, orgId, bookmark.channelId, member.id),
      },
      { channelId: bookmark.channelId },
    );
    res.status(201).json({ bookmark });
  }));

  app.delete('/api/orgs/:orgId/chat/bookmarks/:bookmarkId', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    await deleteBookmark(db, orgId, param(req, 'bookmarkId'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/channels/:channelRef/files', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    res.json({ files: await listChannelFiles(db, orgId, param(req, 'channelRef'), member.id) });
  }));

  app.get('/api/orgs/:orgId/chat/later', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    res.json({ items: await listSaved(db, orgId, member.id, await withNames()) });
  }));

  app.get('/api/orgs/:orgId/chat/activity', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    await flushScheduled(db, orgId, await withNames());
    res.json({ items: await listActivity(db, orgId, member.id, await withNames()) });
  }));

  app.get('/api/orgs/:orgId/chat/reminders', chatHandler(async (req, res) => {
    const { orgId, member, db, withNames } = await ctx.scope(req);
    res.json({ reminders: await listReminders(db, orgId, member.id, await withNames()) });
  }));

  app.delete('/api/orgs/:orgId/chat/reminders/:reminderId', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    await cancelReminder(db, orgId, param(req, 'reminderId'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/scheduled', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    res.json({ messages: await listScheduled(db, orgId, member.id) });
  }));

  app.delete('/api/orgs/:orgId/chat/scheduled/:scheduledId', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    await cancelScheduled(db, orgId, param(req, 'scheduledId'), member.id);
    res.status(204).end();
  }));

  app.get('/api/orgs/:orgId/chat/status', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
    const memberId = typeof req.query.memberId === 'string' ? req.query.memberId : member.id;
    if (req.query.all === '1') {
      res.json({ statuses: await listChatStatuses(db, orgId) });
      return;
    }
    res.json({ status: await getChatStatus(db, orgId, memberId) });
  }));

  app.put('/api/orgs/:orgId/chat/status', chatHandler(async (req, res) => {
    const { orgId, member, db } = await ctx.scope(req);
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
    chatHandler(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:channels');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      await flushScheduled(db, orgId, resolveMemberName);
      const channels = await listChannels(db, orgId, member.id, {
        includeArchived: req.body?.includeArchived === true,
      });
      const totals = await unreadTotals(db, orgId, member.id);
      res.json({ orgId, channels, totalUnread: totals.unread, totalMentions: totals.mentions });
    }),
  );

  app.post(
    '/api/tools/team/members',
    chatHandler(async (req, res) => {
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
    chatHandler(async (req, res) => {
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
    chatHandler(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:dm');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      const memberIds = Array.isArray(req.body?.memberIds)
        ? req.body.memberIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        : typeof req.body?.member === 'string'
          ? req.body.member.split(',').map((id: string) => id.trim()).filter(Boolean)
          : [];
      const channel = await openDirectMessage(db, orgId, member.id, memberIds, resolveMemberName);
      await ctx.emit(orgId, { type: 'channel-created', channel }, {
        channelId: channel.id,
        audience: [member.id, ...memberIds],
      });
      res.status(201).json({ orgId, channel });
    }),
  );

  app.post(
    '/api/tools/team/post',
    chatHandler(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'team:post');
      if (!grant) return;
      const { orgId, member, db, resolveMemberName } = await toolOrgActor(req);
      const people = await listOrgMembers(directory(), orgId);
      const groups = await listUserGroups(db, orgId).catch(() => []);
      const body = (req.body ?? {}) as PostMessageRequest;
      const expanded = expandGroupMentions(String(body.body ?? ''), groups);
      const mentions = [
        ...new Set([
          ...(Array.isArray(body.mentions) ? body.mentions.filter((id) => typeof id === 'string') : []),
          ...extractChatMentions(String(body.body ?? ''), people),
          ...expanded.memberIds,
        ]),
      ];
      const message = await postMessage(
        db,
        orgId,
        requiredChannelRef(req),
        member.id,
        { ...body, mentions },
        resolveMemberName,
        // An agent acts as the organization owner, so it is not stopped by an
        // announcement channel it was deliberately pointed at.
        { isAdmin: true, groupMentions: expanded.groupIds },
      );
      announcePosted(orgId, db, member.id, message);
      res.status(201).json({ orgId, message });
    }),
  );

  return { hub, limiter, maintenance };
}
