// Fan out a posted team-chat message to every browser that should hear it.
// Prefs (mute / mentions-only) live on the channel membership row; the
// subscription itself is per user, looked up after mapping member → user.

import type { ChatChannel, ChatPushPayload, TeamChatMessage } from '@open-design/contracts';
import {
  isSuppressedByDnd,
  messageMentionsMember,
  shouldNotifyChatMember,
} from '@open-design/contracts';
import { listDnd } from './chat-org.js';
import type { SqlExecutor } from '../storage/sql.js';
import { listOrgMembers } from './tenancy.js';
import {
  deletePushSubscriptionById,
  listPushSubscriptionsForUsers,
} from './push-subscriptions.js';
import type { WebPushService } from '../services/web-push.js';

export async function listChatPushMemberIds(
  db: SqlExecutor,
  channelId: string,
  message: Pick<TeamChatMessage, 'authorMemberId' | 'mentions' | 'system'>,
): Promise<string[]> {
  const rows = await db.all<{
    memberId: string;
    muted: number | boolean;
    notify: string | null;
  }>(
    `SELECT member_id AS "memberId", muted, notify
       FROM od_chat_channel_members
      WHERE channel_id = ?`,
    [channelId],
  );
  const ids: string[] = [];
  for (const row of rows) {
    if (
      shouldNotifyChatMember({
        memberId: row.memberId,
        authorMemberId: message.authorMemberId,
        muted: row.muted === 1 || row.muted === true,
        notify: row.notify === 'mentions' || row.notify === 'nothing' ? row.notify : 'all',
        mentions: message.mentions,
        system: message.system,
      })
    ) {
      ids.push(row.memberId);
    }
  }
  return ids;
}

export function chatPushPayload(
  channel: ChatChannel,
  message: TeamChatMessage,
): ChatPushPayload {
  const author = message.authorName?.trim() || 'Someone';
  const title =
    channel.kind === 'dm' || channel.kind === 'group_dm'
      ? author
      : `${author} in ${channel.displayName}`;
  const body = message.body.trim() || (message.attachments.length > 0 ? 'sent an attachment' : '');
  return {
    type: 'team-chat',
    title,
    body: body.slice(0, 140),
    url: `/team/${encodeURIComponent(channel.slug)}`,
    tag: `chat-${channel.id}`,
    orgId: channel.orgId,
    channelSlug: channel.slug,
    messageId: message.id,
  };
}

export async function dispatchChatPush(opts: {
  directory: SqlExecutor;
  db: SqlExecutor;
  orgId: string;
  channel: ChatChannel;
  message: TeamChatMessage;
  webPush: WebPushService;
}): Promise<number> {
  const candidates = await listChatPushMemberIds(opts.db, opts.channel.id, opts.message);
  if (candidates.length === 0) return 0;

  // Quiet hours are applied after channel preferences, not instead of them.
  // The two answer different questions — "do I care about this room" and "am I
  // available right now" — and a member has to pass both. A direct mention
  // still gets through unless they turned that off, because the point of
  // `allowUrgent` is that being named is the exception.
  const dndByMember = await listDnd(opts.db, opts.orgId).catch(() => new Map());
  const memberIds = candidates.filter((memberId) => {
    const dnd = dndByMember.get(memberId);
    if (!dnd) return true;
    return !isSuppressedByDnd(dnd, {
      urgent: messageMentionsMember(opts.message.mentions, memberId),
    });
  });
  if (memberIds.length === 0) return 0;

  const people = await listOrgMembers(opts.directory, opts.orgId);
  const userIds = people.filter((person) => memberIds.includes(person.id)).map((person) => person.userId);
  const subscriptions = await listPushSubscriptionsForUsers(opts.directory, userIds);
  if (subscriptions.length === 0) return 0;
  const payload = chatPushPayload(opts.channel, opts.message);
  let delivered = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await opts.webPush.send(sub, payload);
      if (result === 'gone') {
        await deletePushSubscriptionById(opts.directory, sub.id);
        return;
      }
      if (result === 'delivered') delivered += 1;
    }),
  );
  return delivered;
}
