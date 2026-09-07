// Team chat: channels, messages, and threads inside an organization.
//
// Why this is not a workspace table pack like CRM or purchasing: chat has
// invariants the record engine does not model. A channel has its own member
// list, separate from the organization's; a message is append-mostly and read
// in time order at a volume records were not sized for; and "what have I not
// read" is per-person state, not a row anyone else can see. The ledger earned
// its own tables for the same reason — when the rules differ, the storage
// should say so.
//
// What it deliberately keeps from the rest of the system: organization
// scoping, the same role checks, and record links. A message can point at a
// record, so "the invoice we were arguing about" is a link rather than a
// number pasted into prose.

/** Public channels are visible to, and joinable by, every organization member.
 * Private ones are visible only to their members and never appear in the
 * channel list of someone outside them. */
export type ChannelVisibility = 'public' | 'private';

export type ChannelMemberRole = 'owner' | 'member';

/** How a member is notified in a channel they have joined. `muted` is a
 * shortcut for `nothing` plus hiding the unread badge. */
export type ChatNotifyLevel = 'all' | 'mentions' | 'nothing';

export const CHAT_NOTIFY_LEVELS = ['all', 'mentions', 'nothing'] as const;

export const CHAT_SPECIAL_MENTIONS = ['@channel', '@here', '@everyone'] as const;

export type ChatSpecialMention = (typeof CHAT_SPECIAL_MENTIONS)[number];

/** `channel` is a named room. `dm` is exactly two people. `group_dm` is a
 * private conversation among three or more, without a public slug people join. */
export type ChatChannelKind = 'channel' | 'dm' | 'group_dm';

export interface ChatChannel {
  id: string;
  orgId: string;
  /** Machine name, lowercase and hyphenated, unique per organization —
   * `#deals-emea`. What people type to reach it. Direct messages use a
   * generated `dm-` / `gdm-` slug and are addressed by id in the UI. */
  slug: string;
  displayName: string;
  topic: string | null;
  /** Longer “what this channel is for” copy, distinct from the short topic
   * that sits under the channel name. */
  purpose: string | null;
  kind: ChatChannelKind;
  visibility: ChannelVisibility;
  archivedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Filled on list/read endpoints for the calling member. */
  memberCount: number;
  messageCount: number;
  /** Messages the caller has not read. Absent for a channel they are not in. */
  unreadCount: number;
  /** Whether the caller is a member. Public channels list for everyone, so
   * this is what the UI joins on. */
  joined: boolean;
  lastMessageAt: number | null;
  starred: boolean;
  muted: boolean;
  notify: ChatNotifyLevel;
}

export interface ChatChannelMember {
  id: string;
  channelId: string;
  /** Organization member id (`wsm-…`), so chat identity and organization
   * identity are the same thing. */
  memberId: string;
  displayName: string | null;
  role: ChannelMemberRole;
  joinedAt: number;
  lastReadAt: number;
}

export const TEAM_CHAT_ATTACHMENT_KINDS = [
  'record',
  'app',
  'page',
  'event',
  'proposal',
  'journal-entry',
  'file',
  'link',
] as const;

export type TeamChatAttachmentKind = (typeof TEAM_CHAT_ATTACHMENT_KINDS)[number];

/** 25 MB — enough for a deck or a short clip, small enough that a laptop
 * daemon does not become a file share. */
export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** A reference from a message to something in the organization's data, a
 * uploaded file, or a pasted link. Record/app/page/event/proposal/journal-entry
 * keep chat inside the org; file/link are the media people actually send. */
export interface TeamChatAttachment {
  kind: TeamChatAttachmentKind;
  /** Record/app/page/event/proposal/journal-entry/file id, or the URL for a link. */
  id: string;
  /** Which table the record belongs to. Only set for `kind: 'record'`. */
  tableName?: string;
  /** Human label captured at post time, so the message still reads correctly
   * if the target is later renamed or deleted. */
  label: string;
  /** Org-scoped file URL or the original http(s) link. */
  url?: string;
  mimeType?: string;
  fileName?: string;
  byteSize?: number;
  thumbnailUrl?: string;
}

export interface ChatFileUploadResponse {
  attachment: TeamChatAttachment;
}

const SAFE_HTTP = /^https?:\/\//i;
const SAFE_CHAT_FILE = /^\/api\/orgs\/[A-Za-z0-9._-]+\/chat\/files\/file-[A-Za-z0-9-]+$/;

function isSafeChatUrl(url: string): boolean {
  if (SAFE_HTTP.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return SAFE_CHAT_FILE.test(url);
}

function asTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Drop unknown kinds, javascript: URLs, and incomplete file rows so a
 * crafted payload cannot turn chat into an open redirect or XSS vector. */
export function sanitizeTeamChatAttachments(raw: unknown): TeamChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamChatAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const kind = asTrimmed(rec.kind);
    if (!(TEAM_CHAT_ATTACHMENT_KINDS as readonly string[]).includes(kind)) continue;
    const id = asTrimmed(rec.id);
    const label = asTrimmed(rec.label);
    if (kind === 'link') {
      const url = asTrimmed(rec.url) || id;
      if (!url || !isSafeChatUrl(url) || !SAFE_HTTP.test(url)) continue;
      out.push({ kind: 'link', id: id || url, label: label || url, url });
      continue;
    }
    if (kind === 'file') {
      const url = asTrimmed(rec.url);
      if (!id || !url || !isSafeChatUrl(url)) continue;
      const byteSize = rec.byteSize;
      out.push({
        kind: 'file',
        id,
        label: label || asTrimmed(rec.fileName) || id,
        url,
        ...(asTrimmed(rec.mimeType) ? { mimeType: asTrimmed(rec.mimeType) } : {}),
        ...(asTrimmed(rec.fileName) ? { fileName: asTrimmed(rec.fileName) } : {}),
        ...(typeof byteSize === 'number' && Number.isFinite(byteSize) && byteSize >= 0
          ? { byteSize }
          : {}),
        ...(asTrimmed(rec.thumbnailUrl) && isSafeChatUrl(asTrimmed(rec.thumbnailUrl))
          ? { thumbnailUrl: asTrimmed(rec.thumbnailUrl) }
          : {}),
      });
      continue;
    }
    if (!id || !label) continue;
    out.push({
      kind: kind as Exclude<TeamChatAttachmentKind, 'file' | 'link'>,
      id,
      label,
      ...(kind === 'record' && asTrimmed(rec.tableName) ? { tableName: asTrimmed(rec.tableName) } : {}),
    });
  }
  return out.slice(0, 16);
}

export interface ChatReaction {
  emoji: string;
  count: number;
  /** True when the calling member is among the people who added this emoji. */
  me: boolean;
  memberIds: string[];
}

export interface TeamChatMessage {
  id: string;
  channelId: string;
  orgId: string;
  /** Organization member id of the author, or null for system messages
   * ("Nirek added the purchasing pack"). */
  authorMemberId: string | null;
  authorName: string | null;
  body: string;
  /** Set on messages the daemon wrote itself — joins, template installs,
   * proposal decisions. Rendered differently and never editable. */
  system: boolean;
  attachments: TeamChatAttachment[];
  /** Organization member ids mentioned with `@`. Drives the unread badge. */
  mentions: string[];
  /** The message this one replies to. A thread is a parent plus its replies;
   * there is no separate thread object to keep in sync. */
  parentMessageId: string | null;
  replyCount: number;
  reactions: ChatReaction[];
  editedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  pinned: boolean;
  saved: boolean;
}

// --- Requests -------------------------------------------------------------

export interface CreateChannelRequest {
  /** Optional: derived from `displayName` when omitted. */
  slug?: string;
  displayName: string;
  topic?: string;
  purpose?: string;
  visibility?: ChannelVisibility;
  /** Organization member ids to add on creation. The creator is always added. */
  memberIds?: string[];
}

export interface UpdateChannelRequest {
  displayName?: string;
  topic?: string;
  purpose?: string;
  visibility?: ChannelVisibility;
}

export interface PostMessageRequest {
  body: string;
  attachments?: TeamChatAttachment[];
  mentions?: string[];
  parentMessageId?: string;
  /** When set, the message is held until this epoch-ms instead of posting now. */
  sendAt?: number;
}

export interface EditMessageRequest {
  body: string;
}

export interface ListMessagesQuery {
  /** Page backwards from this message id, newest first. */
  before?: string;
  /** Only replies to this message. */
  parentMessageId?: string;
  limit?: number;
}

export interface MarkReadRequest {
  /** Defaults to now. */
  readAt?: number;
}

export interface MarkUnreadRequest {
  /** Leave everything after this message unread. Defaults to the latest. */
  messageId?: string;
}

export interface UpdateChannelPrefsRequest {
  starred?: boolean;
  muted?: boolean;
  notify?: ChatNotifyLevel;
}

export interface RemindMessageRequest {
  /** Epoch-ms. The UI offers 20 minutes / 1 hour / tomorrow morning. */
  fireAt: number;
  note?: string;
}

export interface SetChatStatusRequest {
  text?: string | null;
  emoji?: string | null;
  /** Epoch-ms, or null to keep it until cleared. */
  expiresAt?: number | null;
}

export interface CreateBookmarkRequest {
  label: string;
  url: string;
  emoji?: string;
}

export interface OpenDirectMessageRequest {
  /** Organization member ids to open a DM with. The caller is always included. */
  memberIds: string[];
}

export interface InviteChannelMembersRequest {
  memberIds: string[];
}

export interface ToggleReactionRequest {
  emoji: string;
}

export interface ChatSearchHit {
  channelId: string;
  channelSlug: string;
  channelName: string;
  kind: ChatChannelKind;
  message: TeamChatMessage;
}

export interface ChatSearchResponse {
  hits: ChatSearchHit[];
}

// --- Responses ------------------------------------------------------------

export interface ChannelListResponse {
  channels: ChatChannel[];
  /** Total unread across every channel the caller is in — the nav badge. */
  totalUnread: number;
}

export interface ChannelResponse {
  channel: ChatChannel;
}

export interface ChannelMembersResponse {
  members: ChatChannelMember[];
}

export interface MessageListResponse {
  messages: TeamChatMessage[];
  /** Cursor for the next page backwards, or null at the beginning of history. */
  nextBefore: string | null;
}

export interface MessageResponse {
  message: TeamChatMessage;
}

// --- Realtime -------------------------------------------------------------

/** Chat events on the SSE stream. The union is closed so a client can switch
 * exhaustively; adding a case is a contract change, which is the point. */
export type ChatStreamEvent =
  | { type: 'message-posted'; channelId: string; message: TeamChatMessage }
  | { type: 'message-edited'; channelId: string; message: TeamChatMessage }
  | { type: 'message-deleted'; channelId: string; messageId: string }
  | { type: 'channel-created'; channel: ChatChannel }
  | { type: 'channel-updated'; channel: ChatChannel }
  | { type: 'member-joined'; channelId: string; member: ChatChannelMember }
  | { type: 'member-left'; channelId: string; memberId: string };

/** Channel slugs must be lowercase letters, digits, and single hyphens. Same
 * spirit as the workspace name pattern, but hyphens instead of underscores
 * because that is what people expect a channel to look like. */
export const CHANNEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const CHAT_MESSAGE_MAX_LENGTH = 8000;

/** The channels a new organization starts with, created on first setup so the
 * room is never empty when someone arrives. */
export const DEFAULT_CHANNELS: ReadonlyArray<{ slug: string; displayName: string; topic: string }> = [
  { slug: 'general', displayName: 'General', topic: 'Everything that does not have a better home.' },
  { slug: 'sales', displayName: 'Sales', topic: 'Deals, quotes, and who is closing what.' },
  { slug: 'purchasing', displayName: 'Purchasing', topic: 'Vendors, orders, and what we owe.' },
];

/** Turn a display name into a usable slug. Exported because the CLI, the web
 * client, and the daemon all need to agree on what `#Q3 Planning` becomes. */
export function slugifyChannelName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export interface ChatSearchFilters {
  text: string;
  in?: string;
  from?: string;
  has?: 'link' | 'file' | 'reaction';
  before?: number;
  after?: number;
}

const HAS_KINDS = new Set(['link', 'file', 'reaction']);

function parseSearchDate(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Slack-style modifiers: `in:general from:ada has:file before:2026-01-01`. */
export function parseChatSearchQuery(raw: string): ChatSearchFilters {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const text: string[] = [];
  const filters: ChatSearchFilters = { text: '' };
  for (const token of tokens) {
    const match = /^(in|from|has|before|after):(.+)$/i.exec(token);
    if (!match) {
      text.push(token);
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = match[2]!.replace(/^#/, '').replace(/^@/, '');
    if (key === 'in') filters.in = value.toLowerCase();
    else if (key === 'from') filters.from = value;
    else if (key === 'has' && HAS_KINDS.has(value.toLowerCase())) {
      filters.has = value.toLowerCase() as 'link' | 'file' | 'reaction';
    } else if (key === 'before') {
      const ts = parseSearchDate(value);
      if (ts !== undefined) filters.before = ts;
    } else if (key === 'after') {
      const ts = parseSearchDate(value);
      if (ts !== undefined) filters.after = ts;
    } else {
      text.push(token);
    }
  }
  filters.text = text.join(' ').trim();
  return filters;
}

export interface ChatMentionMember {
  id: string;
  username?: string | null;
  displayName?: string | null;
}

/** Pull `@ada`, `@channel`, `@here`, and `@everyone` out of a message body. */
export function extractChatMentions(body: string, members: ChatMentionMember[]): string[] {
  const found = new Set<string>();
  const special = /(?:^|[\s(])(@(?:channel|here|everyone))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = special.exec(body))) found.add(match[1]!.toLowerCase());
  const at = /(?:^|[\s(])@([A-Za-z0-9._-]{1,32})/g;
  while ((match = at.exec(body))) {
    const token = match[1]!.toLowerCase();
    if (token === 'channel' || token === 'here' || token === 'everyone') continue;
    const member = members.find((person) => {
      const username = person.username?.trim().toLowerCase();
      const display = person.displayName?.trim().toLowerCase().replace(/\s+/g, '');
      return username === token || display === token;
    });
    if (member) found.add(member.id);
  }
  return [...found];
}

export interface ChatPin {
  id: string;
  channelId: string;
  messageId: string;
  pinnedBy: string;
  pinnedAt: number;
  message: TeamChatMessage;
}

export interface ChatBookmark {
  id: string;
  channelId: string;
  label: string;
  url: string;
  emoji: string | null;
  position: number;
  createdBy: string;
  createdAt: number;
}

export interface ChatReminder {
  id: string;
  orgId: string;
  memberId: string;
  messageId: string;
  fireAt: number;
  note: string | null;
  deliveredAt: number | null;
  createdAt: number;
  message: TeamChatMessage;
  channelId: string;
  channelSlug: string;
  channelName: string;
}

export interface ChatScheduledMessage {
  id: string;
  orgId: string;
  channelId: string;
  channelSlug: string;
  channelName: string;
  authorMemberId: string;
  body: string;
  attachments: TeamChatAttachment[];
  mentions: string[];
  parentMessageId: string | null;
  sendAt: number;
  createdAt: number;
}

export interface ChatStatus {
  memberId: string;
  text: string | null;
  emoji: string | null;
  expiresAt: number | null;
  updatedAt: number;
}

export type ChatActivityKind = 'mention' | 'reaction' | 'thread' | 'reminder';

export interface ChatActivityItem {
  kind: ChatActivityKind;
  createdAt: number;
  channelId: string;
  channelSlug: string;
  channelName: string;
  message: TeamChatMessage;
  actorMemberId?: string;
  actorName?: string | null;
  emoji?: string;
  reminderId?: string;
  note?: string | null;
  fireAt?: number;
}

export interface ChatActivityResponse {
  items: ChatActivityItem[];
}

export interface ChatLaterResponse {
  items: ChatSearchHit[];
}

export interface ChatPinsResponse {
  pins: ChatPin[];
}

export interface ChatBookmarksResponse {
  bookmarks: ChatBookmark[];
}

export interface ChatRemindersResponse {
  reminders: ChatReminder[];
}

export interface ChatScheduledResponse {
  messages: ChatScheduledMessage[];
}

export interface ChatStatusResponse {
  status: ChatStatus | null;
}

export interface ChatFilesResponse {
  files: TeamChatAttachment[];
}
