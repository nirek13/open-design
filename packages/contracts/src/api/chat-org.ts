// The parts of team chat that belong to the organization rather than to one
// conversation: the emoji everybody can use, the groups you can address, the
// way each person arranges their own sidebar, where an unsent draft lives,
// when someone does not want to be interrupted, and how an outside system
// posts in.
//
// These sit apart from `team-chat.ts` because their lifetime is different. A
// message is written once and read forever; a draft is rewritten on every
// keystroke and read by one person. Putting them in one file would say they
// are the same kind of thing.

import type { TeamChatAttachment } from './team-chat.js';

// --- Custom emoji ---------------------------------------------------------

/** `:shipit:` — an image the organization uploaded, usable in a message body
 * and as a reaction, exactly like a unicode emoji. Aliases point at another
 * name instead of an image, so `:lgtm:` can mean `:shipit:` without a second
 * copy of the file. */
export interface ChatCustomEmoji {
  name: string;
  orgId: string;
  /** Org-scoped URL of the image. Null for an alias. */
  url: string | null;
  /** The emoji this one stands for. Null when this row owns an image. */
  aliasFor: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ChatCustomEmojiResponse {
  emoji: ChatCustomEmoji[];
}

export interface CreateChatEmojiAliasRequest {
  name: string;
  aliasFor: string;
}

/** 128 KB. An emoji renders at 22 pixels; anything larger is a picture someone
 * uploaded by accident, and a chat transcript should not carry it on every
 * line it appears. */
export const CHAT_EMOJI_MAX_BYTES = 128 * 1024;

export const CHAT_EMOJI_NAME_PATTERN = /^[a-z0-9][a-z0-9_+-]{0,31}$/;

/** Normalise what someone typed into a storable emoji name: strip the colons,
 * lowercase, and turn spaces into underscores. Exported so the picker, the
 * uploader, and the daemon agree on what `:Ship It:` becomes. */
export function normalizeEmojiName(input: string): string {
  return input
    .trim()
    .replace(/^:+|:+$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_+-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** Follow an alias chain to the row that actually has an image. Bounded, so a
 * cycle introduced by two aliases pointing at each other terminates instead of
 * hanging the renderer. */
export function resolveEmojiAlias(
  name: string,
  emoji: readonly ChatCustomEmoji[],
): ChatCustomEmoji | null {
  const byName = new Map(emoji.map((item) => [item.name, item]));
  let current = byName.get(normalizeEmojiName(name)) ?? null;
  for (let hops = 0; current && current.aliasFor && hops < 8; hops += 1) {
    current = byName.get(current.aliasFor) ?? null;
  }
  return current && current.url ? current : null;
}

// --- User groups ----------------------------------------------------------

/** `@design` — a name that expands to a set of people when it is mentioned.
 * Notification-only: a group does not grant access to anything, it just means
 * everyone in it gets pinged. Keeping it that way is why there is no
 * permission field here. */
export interface ChatUserGroup {
  id: string;
  orgId: string;
  /** Lowercase, hyphenated, unique per organization. What you type after `@`. */
  handle: string;
  name: string;
  description: string | null;
  memberIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatUserGroupsResponse {
  groups: ChatUserGroup[];
}

export interface CreateChatUserGroupRequest {
  handle?: string;
  name: string;
  description?: string;
  memberIds?: string[];
}

export interface UpdateChatUserGroupRequest {
  name?: string;
  description?: string;
  memberIds?: string[];
}

export const CHAT_GROUP_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Turn every `@handle` in a body into the member ids behind it. Returned
 * separately from ordinary mentions so the caller can tell "Ada was named" from
 * "Ada is on a team that was named" if it ever wants to. */
export function expandGroupMentions(
  body: string,
  groups: readonly ChatUserGroup[],
): { groupIds: string[]; memberIds: string[] } {
  const groupIds = new Set<string>();
  const memberIds = new Set<string>();
  const at = /(?:^|[\s(])@([a-z0-9][a-z0-9-]{0,31})/gi;
  let match: RegExpExecArray | null;
  while ((match = at.exec(body))) {
    const handle = match[1]!.toLowerCase();
    const group = groups.find((item) => item.handle === handle);
    if (!group) continue;
    groupIds.add(group.id);
    for (const memberId of group.memberIds) memberIds.add(memberId);
  }
  return { groupIds: [...groupIds], memberIds: [...memberIds] };
}

// --- Sidebar sections -----------------------------------------------------

/** A folder in one person's sidebar. Sections are per member, not per
 * organization: how you arrange your own rooms is not something a colleague
 * should be able to change. */
export interface ChatSection {
  id: string;
  orgId: string;
  memberId: string;
  name: string;
  emoji: string | null;
  position: number;
  collapsed: boolean;
  channelIds: string[];
}

export interface ChatSectionsResponse {
  sections: ChatSection[];
}

export interface CreateChatSectionRequest {
  name: string;
  emoji?: string;
}

export interface UpdateChatSectionRequest {
  name?: string;
  emoji?: string | null;
  position?: number;
  collapsed?: boolean;
  /** Replaces the section's contents. A channel may live in one section at a
   * time, so assigning it here removes it from wherever it was. */
  channelIds?: string[];
}

// --- Drafts ---------------------------------------------------------------

/** An unsent message, kept server-side so the half-written reply you started
 * on a laptop is there on a phone. Keyed by channel plus thread, because the
 * draft in a thread is not the draft in the channel it hangs off. */
export interface ChatDraft {
  channelId: string;
  parentMessageId: string | null;
  body: string;
  attachments: TeamChatAttachment[];
  updatedAt: number;
}

export interface ChatDraftsResponse {
  drafts: ChatDraft[];
}

export interface SaveChatDraftRequest {
  parentMessageId?: string | null;
  body: string;
  attachments?: TeamChatAttachment[];
}

/** Drafts are written on a debounce from the composer, so this is a ceiling on
 * write rate rather than a user-visible delay. */
export const DRAFT_SYNC_DEBOUNCE_MS = 1_500;

// --- Do not disturb -------------------------------------------------------

/** Quiet hours plus a manual snooze. Both suppress push and desktop
 * notifications; neither suppresses the unread badge, because "do not
 * interrupt me" and "hide what I missed" are different requests. */
export interface ChatDndSettings {
  memberId: string;
  /** Local minutes-from-midnight. `start > end` means the window crosses
   * midnight — 22:00 to 08:00 is the normal case, not the exception. */
  scheduleEnabled: boolean;
  startMinute: number;
  endMinute: number;
  /** IANA zone the schedule is expressed in. */
  timezone: string;
  /** Epoch-ms. Set by "snooze for an hour"; overrides the schedule while it
   * lasts, in both directions. */
  snoozeUntil: number | null;
  /** When on, an @mention still notifies during quiet hours. */
  allowUrgent: boolean;
  updatedAt: number;
}

export interface ChatDndResponse {
  dnd: ChatDndSettings;
}

export interface UpdateChatDndRequest {
  scheduleEnabled?: boolean;
  startMinute?: number;
  endMinute?: number;
  timezone?: string;
  snoozeUntil?: number | null;
  allowUrgent?: boolean;
}

/** Minutes-from-midnight in a named zone, without pulling in a date library.
 * `Intl` already knows every zone the platform does; asking it for the hour
 * and minute is cheaper and more correct than arithmetic on UTC offsets that
 * change twice a year. */
export function minutesInZone(at: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(at));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    return ((hour % 24) * 60 + minute) % 1440;
  } catch {
    const date = new Date(at);
    return date.getHours() * 60 + date.getMinutes();
  }
}

/** Whether a notification should be held back right now. Pure, so the daemon
 * (deciding whether to send a push) and the browser (deciding whether to ring)
 * cannot disagree about it. */
export function isSuppressedByDnd(
  dnd: Pick<
    ChatDndSettings,
    'scheduleEnabled' | 'startMinute' | 'endMinute' | 'timezone' | 'snoozeUntil' | 'allowUrgent'
  >,
  options: { at?: number; urgent?: boolean } = {},
): boolean {
  const at = options.at ?? Date.now();
  if (options.urgent && dnd.allowUrgent) return false;
  if (dnd.snoozeUntil && dnd.snoozeUntil > at) return true;
  if (!dnd.scheduleEnabled) return false;
  const now = minutesInZone(at, dnd.timezone);
  const { startMinute: start, endMinute: end } = dnd;
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export const DEFAULT_CHAT_DND: Omit<ChatDndSettings, 'memberId'> = {
  scheduleEnabled: false,
  startMinute: 22 * 60,
  endMinute: 8 * 60,
  timezone: 'UTC',
  snoozeUntil: null,
  allowUrgent: true,
  updatedAt: 0,
};

// --- Incoming webhooks ----------------------------------------------------

/** A URL an outside system can POST to in order to say something in one
 * channel, under a name of its own. The token is shown once, at creation, and
 * stored only as a SHA-256 hash — the same rule invites and share links
 * follow. */
export interface ChatWebhook {
  id: string;
  orgId: string;
  channelId: string;
  channelSlug: string;
  name: string;
  /** Emoji or image URL shown instead of an avatar. */
  icon: string | null;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ChatWebhookCreatedResponse {
  webhook: ChatWebhook;
  /** Returned exactly once. There is no endpoint that can show it again. */
  token: string;
  url: string;
}

export interface ChatWebhooksResponse {
  webhooks: ChatWebhook[];
}

export interface CreateChatWebhookRequest {
  channelId: string;
  name: string;
  icon?: string;
}

/** The body an incoming webhook accepts. Deliberately Slack-shaped so an
 * existing integration pointed at a new URL keeps working. */
export interface ChatWebhookPostRequest {
  text: string;
  username?: string;
  icon_emoji?: string;
  /** Ignored unless the webhook was created without a pinned channel. */
  channel?: string;
  thread_ts?: string;
}

// --- Retention and export -------------------------------------------------

/** How long messages live in a channel. `null` means forever, which is the
 * default; a number is days, after which a message is deleted for good — not
 * soft-deleted, because the point of a retention policy is that the content is
 * gone. */
export interface ChatRetentionPolicy {
  channelId: string;
  days: number | null;
  /** Files attached to expiring messages go with them when true. */
  includeFiles: boolean;
  updatedAt: number;
}

export interface ChatRetentionResponse {
  retention: ChatRetentionPolicy;
}

export interface UpdateChatRetentionRequest {
  days?: number | null;
  includeFiles?: boolean;
}

export interface ChatExportMessage {
  id: string;
  channelSlug: string;
  authorMemberId: string | null;
  authorName: string | null;
  body: string;
  attachments: TeamChatAttachment[];
  parentMessageId: string | null;
  reactions: Array<{ emoji: string; memberIds: string[] }>;
  createdAt: number;
  editedAt: number | null;
}

export interface ChatExportResponse {
  orgId: string;
  exportedAt: number;
  channels: Array<{
    slug: string;
    displayName: string;
    topic: string | null;
    purpose: string | null;
    visibility: string;
    kind: string;
    memberIds: string[];
    messages: ChatExportMessage[];
  }>;
}

// --- Scheduled digest -----------------------------------------------------

/** Everything a member missed, folded into one summary. The shape is
 * deliberately renderable both as a page in the app and as the body of a push
 * notification. */
export interface ChatCatchUpItem {
  channelId: string;
  channelSlug: string;
  channelName: string;
  unreadCount: number;
  mentionCount: number;
  /** The most recent handful, newest last, for a preview. */
  preview: Array<{ authorName: string | null; body: string; createdAt: number }>;
}

export interface ChatCatchUpResponse {
  items: ChatCatchUpItem[];
  totalUnread: number;
  totalMentions: number;
}
