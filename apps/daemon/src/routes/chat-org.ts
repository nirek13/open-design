// Everything around the conversation: the emoji, the groups you can address,
// how each person arranges their sidebar, drafts that follow you between
// devices, quiet hours, huddles, incoming webhooks, retention, and export.
//
// Two access rules run through the whole file and are worth stating once
// rather than at every handler:
//
//   Organization-wide things — emoji, groups, webhooks, retention — are
//   readable by any member and writable by admins. Someone should be able to
//   see `:shipit:` in the picker without being able to delete it.
//
//   Personal things — sections, drafts, quiet hours — are scoped to the caller
//   with no role check at all, because there is no role that entitles you to
//   read somebody else's unsent message.

import type { Express } from 'express';
import multer from 'multer';
import {
  CHAT_EMOJI_MAX_BYTES,
  isSuppressedByDnd,
  type ChatCatchUpItem,
  type ChatExportMessage,
} from '@open-design/contracts';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import { writeChatFile } from '../workspace-data/chat-files.js';
import {
  getChannel,
  listChannels,
  postMessage,
  type ResolveMemberName,
} from '../workspace-data/chat.js';
import {
  applyRetention,
  createEmojiAlias,
  createCustomEmoji,
  createSection,
  createUserGroup,
  createWebhook,
  deleteCustomEmoji,
  deleteDraft,
  deleteSection,
  deleteUserGroup,
  getDnd,
  getRetention,
  listCustomEmoji,
  listDrafts,
  listSections,
  listUserGroups,
  listWebhooks,
  markWebhookUsed,
  resolveWebhookToken,
  revokeWebhook,
  saveDraft,
  setDnd,
  setRetention,
  updateSection,
  updateUserGroup,
} from '../workspace-data/chat-org.js';
import {
  bothInHuddle,
  getHuddle,
  joinHuddle,
  leaveHuddle,
  listLiveHuddles,
  liveHuddle,
  setHuddleState,
} from '../workspace-data/chat-huddles.js';
import { chatHandler, chatParam, type ChatContext } from './chat-context.js';

/** How many messages a catch-up preview shows per channel. Enough to remember
 * what the conversation was about, few enough to scan a dozen channels. */
const CATCH_UP_PREVIEW = 3;

/** The organization is in the path rather than looked up from the token,
 * because on SQLite each organization is its own file and there is nowhere to
 * look a bare token up. Slack's own webhook URLs carry a team id for the same
 * reason; the token is still the only thing that authorises the post. */
export function webhookUrl(orgId: string, token: string): string {
  return `/api/chat/hooks/${encodeURIComponent(orgId)}/${token}`;
}

export function registerChatOrgRoutes(app: Express, ctx: ChatContext, dataDir: string): void {
  const { hub } = ctx.services;
  const emojiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHAT_EMOJI_MAX_BYTES, files: 1 },
  });

  /** Admin-or-refuse, spelled once. Reads as a sentence at the call site,
   * which is the point — a bare `if (!isAdmin) throw` repeated eleven times
   * invites one of them to be written backwards. */
  function requireAdmin(isAdmin: boolean, what: string): void {
    if (isAdmin) return;
    throw new WorkspaceDataError('ORG_ROLE_REQUIRED', 403, `only admins can ${what}`);
  }

  // --- Custom emoji -------------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/emoji',
    chatHandler(async (req, res) => {
      const { orgId, db } = await ctx.scope(req);
      res.json({ emoji: await listCustomEmoji(db, orgId) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/chat/emoji',
    chatHandler(async (req, res) => {
      const { orgId, member, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'add emoji');
      const file = await new Promise<Express.Multer.File | null>((resolve, reject) => {
        emojiUpload.single('image')(req, res, (err: unknown) => {
          if (err) {
            if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
              reject(new WorkspaceDataError('PAYLOAD_TOO_LARGE', 413, 'an emoji must be 128 KB or smaller'));
              return;
            }
            reject(err);
            return;
          }
          resolve(req.file ?? null);
        });
      });

      // Two ways to add one: upload an image, or point a new name at an
      // existing emoji. The absence of a file is what distinguishes them,
      // rather than a mode flag the caller could get wrong.
      const name = String(req.body?.name ?? '');
      if (!file) {
        const aliasFor = String(req.body?.aliasFor ?? '');
        if (!aliasFor) {
          throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'upload an image or name an alias target');
        }
        res.status(201).json({ emoji: await createEmojiAlias(db, orgId, member.id, { name, aliasFor }) });
        return;
      }
      if (!file.mimetype.startsWith('image/')) {
        throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'an emoji must be an image');
      }
      const stored = await writeChatFile(dataDir, orgId, file.buffer, file.originalname || 'emoji', file.mimetype);
      res.status(201).json({
        emoji: await createCustomEmoji(db, orgId, member.id, { name, url: stored.url! }),
      });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/chat/emoji/:name',
    chatHandler(async (req, res) => {
      const { orgId, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'remove emoji');
      await deleteCustomEmoji(db, orgId, chatParam(req, 'name'));
      res.status(204).end();
    }),
  );

  // --- User groups --------------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/groups',
    chatHandler(async (req, res) => {
      const { orgId, db } = await ctx.scope(req);
      res.json({ groups: await listUserGroups(db, orgId) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/chat/groups',
    chatHandler(async (req, res) => {
      const { orgId, member, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'create groups');
      res.status(201).json({ group: await createUserGroup(db, orgId, member.id, req.body ?? {}) });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/chat/groups/:groupId',
    chatHandler(async (req, res) => {
      const { orgId, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'change groups');
      res.json({ group: await updateUserGroup(db, orgId, chatParam(req, 'groupId'), req.body ?? {}) });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/chat/groups/:groupId',
    chatHandler(async (req, res) => {
      const { orgId, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'delete groups');
      await deleteUserGroup(db, orgId, chatParam(req, 'groupId'));
      res.status(204).end();
    }),
  );

  // --- Sidebar sections ---------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/sections',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      res.json({ sections: await listSections(db, orgId, member.id) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/chat/sections',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      res.status(201).json({ section: await createSection(db, orgId, member.id, req.body ?? {}) });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/chat/sections/:sectionId',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      res.json({
        sections: await updateSection(db, orgId, member.id, chatParam(req, 'sectionId'), req.body ?? {}),
      });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/chat/sections/:sectionId',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      await deleteSection(db, orgId, member.id, chatParam(req, 'sectionId'));
      res.status(204).end();
    }),
  );

  // --- Drafts -------------------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/drafts',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      res.json({ drafts: await listDrafts(db, orgId, member.id) });
    }),
  );

  app.put(
    '/api/orgs/:orgId/chat/channels/:channelRef/draft',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      const draft = await saveDraft(db, orgId, member.id, channel.id, {
        parentMessageId:
          typeof req.body?.parentMessageId === 'string' ? req.body.parentMessageId : null,
        body: String(req.body?.body ?? ''),
        attachments: req.body?.attachments,
      });
      res.json({ draft });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/chat/channels/:channelRef/draft',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      await deleteDraft(
        db,
        member.id,
        channel.id,
        typeof req.query.parentMessageId === 'string' ? req.query.parentMessageId : null,
      );
      res.status(204).end();
    }),
  );

  // --- Do not disturb -----------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/dnd',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const dnd = await getDnd(db, orgId, member.id);
      res.json({ dnd, active: isSuppressedByDnd(dnd) });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/chat/dnd',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const dnd = await setDnd(db, orgId, member.id, req.body ?? {});
      res.json({ dnd, active: isSuppressedByDnd(dnd) });
    }),
  );

  // --- Huddles ------------------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/huddles',
    chatHandler(async (req, res) => {
      const { orgId, db, withNames } = await ctx.scope(req);
      res.json({ huddles: await listLiveHuddles(db, orgId, await withNames()) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/chat/channels/:channelRef/huddle',
    chatHandler(async (req, res) => {
      const { orgId, member, db, withNames } = await ctx.scope(req);
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      const names = await withNames();
      const before = await liveHuddle(db, orgId, channel.id, names);
      const huddle = await joinHuddle(db, orgId, channel.id, member.id, names);
      // A huddle starting is different news from someone joining one: the
      // first puts a live dot on the channel for everybody, the second only
      // updates a roster people already have open.
      ctx.emitSoon(
        orgId,
        before
          ? { type: 'huddle-roster', channelId: channel.id, huddle }
          : { type: 'huddle-started', channelId: channel.id, huddle },
        { channelId: channel.id },
      );
      res.status(before ? 200 : 201).json({ huddle });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/chat/huddles/:huddleId',
    chatHandler(async (req, res) => {
      const { orgId, member, db, withNames } = await ctx.scope(req);
      const { huddle, ended } = await leaveHuddle(
        db,
        orgId,
        chatParam(req, 'huddleId'),
        member.id,
        await withNames(),
      );
      ctx.emitSoon(
        orgId,
        ended
          ? { type: 'huddle-ended', channelId: huddle.channelId, huddleId: huddle.id }
          : { type: 'huddle-roster', channelId: huddle.channelId, huddle },
        { channelId: huddle.channelId },
      );
      res.json({ huddle, ended });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/chat/huddles/:huddleId',
    chatHandler(async (req, res) => {
      const { orgId, member, db, withNames } = await ctx.scope(req);
      const huddle = await setHuddleState(
        db,
        orgId,
        chatParam(req, 'huddleId'),
        member.id,
        { muted: req.body?.muted, sharing: req.body?.sharing },
        await withNames(),
      );
      ctx.emitSoon(
        orgId,
        { type: 'huddle-roster', channelId: huddle.channelId, huddle },
        { channelId: huddle.channelId },
      );
      res.json({ huddle });
    }),
  );

  /** Relay one WebRTC frame to one peer.
   *
   * The daemon does not read the payload — an SDP or an ICE candidate is the
   * browsers' business. What it does check is that sender and recipient are
   * both currently in this huddle, so holding a huddle id is not enough to
   * push arbitrary JSON at somebody's browser. Ephemeral, so a frame arriving
   * for a peer who has already left is dropped rather than queued. */
  app.post(
    '/api/orgs/:orgId/chat/huddles/:huddleId/signal',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const huddleId = chatParam(req, 'huddleId');
      const toMemberId = String(req.body?.toMemberId ?? '');
      const kind = req.body?.kind;
      if (kind !== 'offer' && kind !== 'answer' && kind !== 'candidate' && kind !== 'bye') {
        throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'kind must be offer, answer, candidate, or bye');
      }
      if (!toMemberId || toMemberId === member.id) {
        throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'name the peer to signal');
      }
      if (!(await bothInHuddle(db, huddleId, member.id, toMemberId))) {
        throw new WorkspaceDataError('HUDDLE_NOT_FOUND', 404, 'you are not both in that huddle');
      }
      hub.publishEphemeral(
        orgId,
        {
          type: 'huddle-signal',
          signal: { huddleId, fromMemberId: member.id, toMemberId, kind, payload: req.body?.payload },
        },
        { audience: [toMemberId] },
      );
      res.status(202).json({ delivered: true });
    }),
  );

  app.get(
    '/api/orgs/:orgId/chat/huddles/:huddleId',
    chatHandler(async (req, res) => {
      const { orgId, db, withNames } = await ctx.scope(req);
      res.json({ huddle: await getHuddle(db, orgId, chatParam(req, 'huddleId'), await withNames()) });
    }),
  );

  // --- Incoming webhooks --------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/webhooks',
    chatHandler(async (req, res) => {
      const { orgId, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'see webhooks');
      res.json({ webhooks: await listWebhooks(db, orgId) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/chat/webhooks',
    chatHandler(async (req, res) => {
      const { orgId, member, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'create webhooks');
      const { webhook, token } = await createWebhook(db, orgId, member.id, req.body ?? {});
      // The token appears here and nowhere else, ever. There is deliberately
      // no endpoint that can show it again.
      res.status(201).json({ webhook, token, url: webhookUrl(orgId, token) });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/chat/webhooks/:webhookId',
    chatHandler(async (req, res) => {
      const { orgId, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'revoke webhooks');
      await revokeWebhook(db, orgId, chatParam(req, 'webhookId'));
      res.status(204).end();
    }),
  );

  /** Post as a webhook.
   *
   * The only chat endpoint with no session: the token in the URL is the whole
   * credential, which is why it is 32 random bytes and why only its hash is
   * stored. A revoked or unknown token is a flat 404 — telling a caller that
   * their token is merely expired is telling them the URL shape was right.
   *
   * The body is Slack-shaped (`text`, `username`, `icon_emoji`) so an existing
   * integration can be repointed at this URL without being rewritten. */
  app.post(
    '/api/chat/hooks/:orgId/:token',
    chatHandler(async (req, res) => {
      const orgId = chatParam(req, 'orgId');
      const db = ctx.services.manager.workspaceExecutor(orgId);
      const hook = await resolveWebhookToken(db, chatParam(req, 'token'));
      if (!hook || hook.orgId !== orgId) {
        throw new WorkspaceDataError('CHAT_WEBHOOK_NOT_FOUND', 404, 'unknown webhook');
      }
      if (!ctx.allow(res, 'chat:webhook', `${orgId}:${hook.id}`)) return;

      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!text.trim()) {
        throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'text is required');
      }
      const message = await postMessage(
        db,
        orgId,
        hook.channelId,
        hook.createdBy,
        {
          body: text,
          ...(typeof req.body?.thread_ts === 'string' && req.body.thread_ts
            ? { parentMessageId: req.body.thread_ts }
            : {}),
        },
        undefined,
        {
          // A webhook posts under its own name, and an announcement channel
          // does not stop the integration its admins wired up on purpose.
          isAdmin: true,
          bot: {
            name: (typeof req.body?.username === 'string' && req.body.username.trim()) || hook.name,
            icon: (typeof req.body?.icon_emoji === 'string' && req.body.icon_emoji.trim()) || hook.icon,
          },
        },
      );
      await markWebhookUsed(db, hook.id);
      ctx.emitSoon(
        orgId,
        { type: 'message-posted', channelId: hook.channelId, message },
        { channelId: hook.channelId },
      );
      res.status(201).json({ ok: true, messageId: message.id });
    }),
  );

  // --- Retention ----------------------------------------------------------

  app.get(
    '/api/orgs/:orgId/chat/channels/:channelRef/retention',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      res.json({ retention: await getRetention(db, orgId, channel.id) });
    }),
  );

  app.put(
    '/api/orgs/:orgId/chat/channels/:channelRef/retention',
    chatHandler(async (req, res) => {
      const { orgId, member, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'set retention');
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      res.json({ retention: await setRetention(db, orgId, channel.id, req.body ?? {}) });
    }),
  );

  /** Run every retention policy now. Normally a timer does this; the endpoint
   * exists so an admin who has just shortened a policy can see it take effect
   * rather than wondering whether it did. */
  app.post(
    '/api/orgs/:orgId/chat/retention/apply',
    chatHandler(async (req, res) => {
      const { orgId, db, isAdmin } = await ctx.scope(req);
      requireAdmin(isAdmin, 'apply retention');
      const removed = await applyRetention(db, orgId);
      res.json({ removed: Object.fromEntries(removed), total: [...removed.values()].reduce((a, b) => a + b, 0) });
    }),
  );

  // --- Export -------------------------------------------------------------

  /** Everything the caller can see, as one JSON document.
   *
   * Scoped to the caller rather than to the organization on purpose: an admin
   * exporting a workspace should not thereby read private channels they were
   * never in. An export that quietly widens access is a data breach with a
   * download button. */
  app.get(
    '/api/orgs/:orgId/chat/export',
    chatHandler(async (req, res) => {
      const { orgId, member, db, withNames } = await ctx.scope(req);
      const names = await withNames();
      const channels = await listChannels(db, orgId, member.id, { includeArchived: true });
      const wanted = typeof req.query.channel === 'string' ? req.query.channel : '';
      const selected = wanted
        ? channels.filter((channel) => channel.slug === wanted || channel.id === wanted)
        : channels;

      const out = [];
      for (const channel of selected) {
        if (channel.visibility === 'private' && !channel.joined) continue;
        out.push({
          slug: channel.slug,
          displayName: channel.displayName,
          topic: channel.topic,
          purpose: channel.purpose,
          visibility: channel.visibility,
          kind: channel.kind,
          memberIds: await exportMemberIds(db, channel.id),
          messages: await exportMessages(db, channel.id, channel.slug, names),
        });
      }
      res.json({ orgId, exportedAt: Date.now(), channels: out });
    }),
  );

  // --- Catch up -----------------------------------------------------------

  /** What you missed, folded into one summary. The same shape drives the
   * in-app "catch up" pane and a digest notification, so the two can never
   * disagree about what counted as unread. */
  app.get(
    '/api/orgs/:orgId/chat/catch-up',
    chatHandler(async (req, res) => {
      const { orgId, member, db, withNames } = await ctx.scope(req);
      const names = await withNames();
      const channels = await listChannels(db, orgId, member.id);
      const items: ChatCatchUpItem[] = [];
      let totalUnread = 0;
      let totalMentions = 0;
      for (const channel of channels) {
        if (!channel.joined || channel.unreadCount + channel.mentionCount === 0) continue;
        totalUnread += channel.unreadCount;
        totalMentions += channel.mentionCount;
        const rows = await db.all<Record<string, any>>(
          `SELECT author_member_id AS "authorMemberId", bot_name AS "botName", body,
                  created_at AS "createdAt"
             FROM od_chat_messages
            WHERE channel_id = ? AND deleted_at IS NULL AND system = 0
            ORDER BY created_at DESC LIMIT ?`,
          [channel.id, CATCH_UP_PREVIEW],
        );
        items.push({
          channelId: channel.id,
          channelSlug: channel.slug,
          channelName: channel.displayName,
          unreadCount: channel.unreadCount,
          mentionCount: channel.mentionCount,
          preview: rows
            .reverse()
            .map((row) => ({
              authorName: row.authorMemberId ? names(row.authorMemberId) : (row.botName ?? null),
              body: String(row.body ?? '').slice(0, 240),
              createdAt: Number(row.createdAt),
            })),
        });
      }
      // Rooms that called your name first; the rest by how much is waiting.
      items.sort((a, b) => b.mentionCount - a.mentionCount || b.unreadCount - a.unreadCount);
      res.json({ items, totalUnread, totalMentions });
    }),
  );
}

async function exportMemberIds(
  db: import('../storage/sql.js').SqlExecutor,
  channelId: string,
): Promise<string[]> {
  const rows = await db.all<{ memberId: string }>(
    'SELECT member_id AS "memberId" FROM od_chat_channel_members WHERE channel_id = ? ORDER BY joined_at ASC',
    [channelId],
  );
  return rows.map((row) => row.memberId);
}

async function exportMessages(
  db: import('../storage/sql.js').SqlExecutor,
  channelId: string,
  channelSlug: string,
  names: ResolveMemberName,
): Promise<ChatExportMessage[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT id, author_member_id AS "authorMemberId", bot_name AS "botName", body,
            attachments_json AS "attachmentsJson", parent_message_id AS "parentMessageId",
            created_at AS "createdAt", edited_at AS "editedAt"
       FROM od_chat_messages
      WHERE channel_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [channelId],
  );
  if (rows.length === 0) return [];
  const reactions = new Map<string, Map<string, string[]>>();
  const placeholders = rows.map(() => '?').join(', ');
  for (const row of await db.all<{ messageId: string; emoji: string; memberId: string }>(
    `SELECT message_id AS "messageId", emoji, member_id AS "memberId"
       FROM od_chat_reactions WHERE message_id IN (${placeholders})`,
    rows.map((row) => row.id),
  )) {
    let byEmoji = reactions.get(row.messageId);
    if (!byEmoji) {
      byEmoji = new Map();
      reactions.set(row.messageId, byEmoji);
    }
    byEmoji.set(row.emoji, [...(byEmoji.get(row.emoji) ?? []), row.memberId]);
  }
  return rows.map((row) => ({
    id: row.id,
    channelSlug,
    authorMemberId: row.authorMemberId ?? null,
    authorName: row.authorMemberId ? names(row.authorMemberId) : (row.botName ?? null),
    body: String(row.body ?? ''),
    attachments: parseAttachments(row.attachmentsJson),
    parentMessageId: row.parentMessageId ?? null,
    reactions: [...(reactions.get(row.id) ?? new Map()).entries()].map(([emoji, memberIds]) => ({
      emoji,
      memberIds,
    })),
    createdAt: Number(row.createdAt),
    editedAt: row.editedAt === null || row.editedAt === undefined ? null : Number(row.editedAt),
  }));
}

function parseAttachments(raw: unknown): ChatExportMessage['attachments'] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatExportMessage['attachments']) : [];
  } catch {
    return [];
  }
}
