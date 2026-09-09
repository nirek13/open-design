// Slack-shaped workspace chat. Messages live in the organization database.
//
// Everything here is driven by one live stream. A message someone else sends
// arrives as an event and is applied to the transcript in place; the only
// refetch is when the stream says it could not catch us up, or when a change
// touches something the event does not carry (a channel's unread count after
// a read marker moves, say). Opening a channel marks it read; posting does
// not. Web Push covers the case where nothing is open at all.
//
// The previous version asked for the whole open channel every five seconds.
// That is why this file no longer has a poll timer, and why it can show that
// somebody is typing — you cannot poll for that.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Badge, Button, EmptyState, Input, Skeleton, Textarea } from '@open-design/components';
import {
  CHAT_FILE_MAX_BYTES,
  DRAFT_SYNC_DEBOUNCE_MS,
  personLabel,
  workspaceLabel,
  type ChatActivityItem,
  type ChatBookmark,
  type ChatChannel,
  type ChatCustomEmoji,
  type ChatDndSettings,
  type ChatPin,
  type ChatReminder,
  type ChatScheduledMessage,
  type ChatSearchHit,
  type ChatSection,
  type ChatStatus,
  type ChatStreamEvent,
  type ChatUserGroup,
  type OrgMember,
  type TeamChatAttachment,
  type TeamChatMessage,
} from '@open-design/contracts';
import { PersonAvatar } from '../account/PersonAvatar';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { useOptionalRunningApp } from '../apps/RunningAppContext';
import {
  archiveChatChannel,
  cancelChatReminder,
  cancelChatScheduled,
  createChatBookmark,
  createChatChannel,
  deleteChatBookmark,
  deleteChatMessage,
  editChatMessage,
  fetchChatActivity,
  fetchChatBookmarks,
  fetchChatChannelFiles,
  fetchChatChannelMembers,
  fetchChatChannels,
  fetchChatLater,
  fetchChatMessages,
  fetchChatPins,
  fetchChatReminders,
  fetchChatScheduled,
  fetchChatStatuses,
  fetchDesignSystemFile,
  fetchDesignSystemFiles,
  fetchDesignSystems,
  fetchOrgApps,
  fetchOrgMembers,
  inviteChatMembers,
  joinChatChannel,
  leaveChatChannel,
  markChatChannelRead,
  markChatChannelUnread,
  openChatDirectMessage,
  postChatMessage,
  remindChatMessage,
  searchChatMessages,
  setMyChatStatus,
  setUpChatChannels,
  toggleChatPin,
  toggleChatReaction,
  toggleChatSave,
  unarchiveChatChannel,
  updateChatChannel,
  updateChatChannelPrefs,
  uploadChatFile,
  createChatSection,
  deleteChatSection,
  fetchChatDnd,
  fetchChatDrafts,
  fetchChatEmoji,
  fetchChatGroups,
  fetchChatSections,
  forwardChatMessage,
  saveChatDraft,
  updateChatDnd,
  updateChatSection,
} from '../../providers/registry';
import { navigate } from '../../router';
import {
  chatAccentCssVars,
  DEFAULT_CHAT_ACCENT,
  filesFromTransfer,
  parseChatAccent,
  type ChatAccent,
} from '../../runtime/chat-media';
import {
  chatWhen,
  parseRemindWhen,
  parseSlashCommand,
  SLASH_HELP,
  wrapSelection,
} from '../../runtime/chat-format';
import { enableChatPush } from '../../runtime/chat-push';
import { showChatNotification } from '../../utils/notifications';
import { CHAT_EMOJI_GROUPS, QUICK_REACTIONS } from '../../runtime/chat-emoji';
import { Icon } from '../Icon';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { ChatMessageBody } from './ChatMessageBody';
import { ChatEmojiProvider } from './ChatEmojiContext';
import { useTeamChatRealtime } from './useTeamChatRealtime';
import { useChatHuddle } from './useChatHuddle';
import { presenceState } from '../../runtime/team-chat-stream';
import {
  applyChatSuggestion,
  chatSuggestions,
  readChatAutocomplete,
  type ChatSuggestion,
} from '../../runtime/chat-autocomplete';
import {
  attachmentFileSource,
  ChatFileLightbox,
  PendingChatFile,
  type ChatFileSource,
} from './ChatFileViewer';
import styles from './TeamChatView.module.css';

interface Props {
  active: boolean;
  initialChannelId?: string;
  homeView?: 'team' | 'slack';
}

const DRAFT_PREFIX = 'od:chat-draft:';
const HISTORY_PREFIX = 'od:chat-history:';
const HISTORY_LIMIT = 40;

type ChatPane = 'channel' | 'unreads' | 'dms' | 'activity' | 'later' | 'history' | 'browse' | 'reminders' | 'scheduled';

function readChatHistory(orgId: string): string[] {
  try {
    const raw = window.localStorage.getItem(`${HISTORY_PREFIX}${orgId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function rememberChatHistory(orgId: string, slug: string): string[] {
  const next = [slug, ...readChatHistory(orgId).filter((item) => item !== slug)].slice(0, HISTORY_LIMIT);
  window.localStorage.setItem(`${HISTORY_PREFIX}${orgId}`, JSON.stringify(next));
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDirect(channel: ChatChannel): boolean {
  return channel.kind === 'dm' || channel.kind === 'group_dm';
}

function labelPerson(
  person: Pick<OrgMember, 'displayName' | 'username' | 'email'> | undefined,
  storedName: string | null | undefined,
  fallback: string,
): string {
  return personLabel(
    {
      displayName: person?.displayName || storedName,
      username: person?.username,
      email: person?.email,
    },
    fallback,
  );
}

function formatClock(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function mentionsCaller(
  message: TeamChatMessage,
  memberId: string | null,
  username: string | null | undefined,
): boolean {
  if (message.mentions.includes('@channel') || message.mentions.includes('@here') || message.mentions.includes('@everyone')) {
    return true;
  }
  if (memberId && message.mentions.includes(memberId)) return true;
  if (username && message.body.toLowerCase().includes(`@${username.toLowerCase()}`)) return true;
  return false;
}

function notifyMention(body: string, channelName: string, url?: string, tag?: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  void showChatNotification({
    title: channelName,
    body: body.slice(0, 140),
    url: url ?? `/team`,
    tag: tag ?? `chat-${channelName}`,
  });
}

function lookupPerson(people: OrgMember[], token: string): OrgMember | undefined {
  const needle = token.replace(/^@/, '').trim().toLowerCase();
  if (!needle) return undefined;
  return people.find((person) =>
    person.username?.toLowerCase() === needle
    || person.displayName?.toLowerCase() === needle
    || person.id.toLowerCase() === needle,
  );
}

export function TeamChatView({ active, initialChannelId, homeView = 'team' }: Props) {
  const t = useT();
  const org = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const { activeOrgId, activeOrg, auth } = org;

  const viewerUserId = auth?.viewer?.userId ?? null;
  const runningApp = useOptionalRunningApp();

  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [people, setPeople] = useState<OrgMember[]>([]);
  const [currentSlug, setCurrentSlug] = useState<string | null>(initialChannelId ?? null);
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<TeamChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [threadDraft, setThreadDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [dmPicks, setDmPicks] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [searchHits, setSearchHits] = useState<TeamChatMessage[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [viewingFile, setViewingFile] = useState<ChatFileSource | null>(null);
  const [dropping, setDropping] = useState(false);
  const [accent, setAccent] = useState<ChatAccent>(DEFAULT_CHAT_ACCENT);
  const [pane, setPane] = useState<ChatPane>('channel');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<'about' | 'members' | 'files' | 'pins'>('about');
  const [emojiOpen, setEmojiOpen] = useState<'main' | 'thread' | false>(false);
  const [statusDraft, setStatusDraft] = useState('');
  const [statusOpen, setStatusOpen] = useState(false);
  const [jumpQuery, setJumpQuery] = useState('');
  const [jumpOpen, setJumpOpen] = useState(false);
  const [activity, setActivity] = useState<ChatActivityItem[]>([]);
  const [later, setLater] = useState<ChatSearchHit[]>([]);
  const [reminders, setReminders] = useState<ChatReminder[]>([]);
  const [scheduled, setScheduled] = useState<ChatScheduledMessage[]>([]);
  const [pins, setPins] = useState<ChatPin[]>([]);
  const [bookmarks, setBookmarks] = useState<ChatBookmark[]>([]);
  const [channelFiles, setChannelFiles] = useState<TeamChatAttachment[]>([]);
  const [channelMembers, setChannelMembers] = useState<import('@open-design/contracts').ChatChannelMember[]>([]);
  const [statuses, setStatuses] = useState<ChatStatus[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [topicDraft, setTopicDraft] = useState('');
  const [purposeDraft, setPurposeDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadAfter, setUnreadAfter] = useState<number | null>(null);
  const [alsoSend, setAlsoSend] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [remindMenu, setRemindMenu] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [hideStarred, setHideStarred] = useState(false);
  const [hideChannels, setHideChannels] = useState(false);
  const [hideDms, setHideDms] = useState(false);
  const [historySlugs, setHistorySlugs] = useState<string[]>([]);
  const [customEmoji, setCustomEmoji] = useState<ChatCustomEmoji[]>([]);
  const [groups, setGroups] = useState<ChatUserGroup[]>([]);
  const [sections, setSections] = useState<ChatSection[]>([]);
  const [dnd, setDnd] = useState<ChatDndSettings | null>(null);
  const [dndActive, setDndActive] = useState(false);
  const [suggestions, setSuggestions] = useState<ChatSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionFor, setSuggestionFor] = useState<'main' | 'thread' | null>(null);
  const [draftsBySlug, setDraftsBySlug] = useState<Record<string, string>>({});
  const [newSectionName, setNewSectionName] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mainComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastNotifiedId = useRef<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  const myMemberId = useMemo(
    () => people.find((person) => person.userId === viewerUserId)?.id ?? null,
    [people, viewerUserId],
  );

  /** Every way the viewer can be addressed, so a mention of any of them is
   * highlighted. A group the viewer belongs to counts: being named as part of
   * @design is being named. */
  const selfHandles = useMemo(() => {
    const me = people.find((person) => person.id === myMemberId);
    const own = [me?.username, me?.displayName?.replace(/\s+/g, '')].filter(
      (value): value is string => Boolean(value),
    );
    const mine = groups
      .filter((group) => myMemberId && group.memberIds.includes(myMemberId))
      .map((group) => group.handle);
    return [...own, ...mine];
  }, [people, myMemberId, groups]);

  // The huddle controller owns the peer connections and the microphone. It is
  // created before the stream handler because that handler feeds signalling
  // frames into it.
  const huddle = useChatHuddle(activeOrgId ?? null, myMemberId);

  /** Owners and admins see the settings that change what other people may do.
   * The daemon enforces this regardless; hiding the control is so nobody is
   * offered a switch that will refuse them. `can` is the organization
   * context's own answer, so the chat view does not get a second opinion
   * about roles. */
  const isOrgAdmin = org.can('admin');

  const openAttachment = useCallback(
    async (attachment: TeamChatAttachment) => {
      if (attachment.kind === 'page') {
        navigate({ kind: 'home', view: 'pages', pageId: attachment.id });
        return;
      }
      if (attachment.kind === 'event') {
        navigate({ kind: 'home', view: 'calendar', eventId: attachment.id });
        return;
      }
      if (attachment.kind !== 'app' || !activeOrgId || !runningApp) return;
      try {
        const apps = await fetchOrgApps(activeOrgId);
        const found = apps.find((item) => item.id === attachment.id);
        if (found) await runningApp.openApp(activeOrgId, found);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [activeOrgId, runningApp],
  );

  const accentVars = useMemo(() => chatAccentCssVars(accent) as CSSProperties, [accent]);

  useEffect(() => {
    const designSystemId = activeOrg?.defaultDesignSystemId;
    if (!active || !designSystemId) {
      setAccent(DEFAULT_CHAT_ACCENT);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const systems = await fetchDesignSystems();
        const summary = systems.find((system) => system.id === designSystemId);
        const files = await fetchDesignSystemFiles(designSystemId);
        const tokenFile = files.find((file) => /tokens\.(css|json)$/i.test(file.path) || file.kind === 'stylesheet');
        let css = '';
        if (tokenFile) {
          const detail = await fetchDesignSystemFile(designSystemId, tokenFile.path);
          css = detail?.content ?? '';
        }
        if (!cancelled) {
          setAccent(parseChatAccent(css, summary?.swatches ?? []) ?? DEFAULT_CHAT_ACCENT);
        }
      } catch {
        if (!cancelled) setAccent(DEFAULT_CHAT_ACCENT);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, activeOrg?.defaultDesignSystemId]);

  const rooms = useMemo(() => channels.filter((channel) => !isDirect(channel)), [channels]);
  const dms = useMemo(() => channels.filter(isDirect), [channels]);
  const starredRooms = useMemo(
    () => channels.filter((channel) => channel.starred && channel.joined),
    [channels],
  );
  const historyRooms = useMemo(() => {
    const bySlug = new Map(channels.map((channel) => [channel.slug, channel]));
    const fromRecents = historySlugs
      .map((slug) => bySlug.get(slug))
      .filter((channel): channel is ChatChannel => Boolean(channel));
    if (fromRecents.length > 0) return fromRecents;
    return [...channels]
      .filter((channel) => channel.joined && channel.lastMessageAt)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }, [channels, historySlugs]);
  const current = channels.find((channel) => channel.slug === currentSlug || channel.id === currentSlug) ?? null;
  const parentInThread = messages.find((message) => message.id === threadId) ?? threadMessages[0] ?? null;

  const loadChannels = useCallback(async () => {
    if (!activeOrgId) return [] as ChatChannel[];
    const result = await fetchChatChannels(activeOrgId);
    setChannels(result.channels);
    setLoaded(true);
    return result.channels;
  }, [activeOrgId]);

  const loadMessages = useCallback(async (slug: string, before?: string) => {
    if (!activeOrgId) return;
    const result = await fetchChatMessages(activeOrgId, slug, { limit: 80, before });
    if (before) {
      setMessages((prev) => {
        const seen = new Set(prev.map((message) => message.id));
        return [...result.messages.filter((message) => !seen.has(message.id)), ...prev];
      });
    } else {
      setMessages(result.messages);
    }
    setNextBefore(result.nextBefore);
  }, [activeOrgId]);

  useEffect(() => {
    if (initialChannelId) setCurrentSlug(initialChannelId);
  }, [initialChannelId]);

  useEffect(() => {
    if (!active || !activeOrgId) return;
    void (async () => {
      try {
        const [next, members] = await Promise.all([
          loadChannels(),
          fetchOrgMembers(activeOrgId).catch(() => [] as OrgMember[]),
        ]);
        setPeople(members.filter((member) => member.status === 'active'));
        setCurrentSlug((prev) => prev ?? next.find((channel) => channel.joined)?.slug ?? next[0]?.slug ?? null);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [active, activeOrgId, loadChannels]);

  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug || !myMemberId) return;
    void (async () => {
      try {
        const members = await fetchChatChannelMembers(activeOrgId, currentSlug).catch(() => []);
        const mine = members.find((row) => row.memberId === myMemberId);
        setUnreadAfter(mine && mine.lastReadAt > 0 ? mine.lastReadAt : null);
        await loadMessages(currentSlug);
        pinnedToBottom.current = true;
        setAtBottom(true);
        await markChatChannelRead(activeOrgId, currentSlug);
        await loadChannels();
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [active, activeOrgId, currentSlug, loadChannels, loadMessages, myMemberId]);

  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug || !threadId) {
      setThreadMessages([]);
      return;
    }
    let cancelled = false;
    void fetchChatMessages(activeOrgId, currentSlug, { parentMessageId: threadId, limit: 80 })
      .then((result) => {
        if (!cancelled) setThreadMessages(result.messages);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeOrgId, currentSlug, threadId]);

  // --- Live updates -------------------------------------------------------
  //
  // One event handler for the whole view. It patches what it can and refetches
  // only what an event genuinely cannot carry: an unread count depends on the
  // reader's own marker, so a `message-posted` for another channel means "ask
  // again", not "increment".

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = current?.id ?? null;
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = threadId;
  // Read inside the event handler to find a deleted reply's parent. Refs
  // rather than dependencies, so a message arriving does not rebuild the
  // handler and, through it, the stream subscription.
  const messagesRef = useRef<TeamChatMessage[]>([]);
  messagesRef.current = messages;
  const threadMessagesRef = useRef<TeamChatMessage[]>([]);
  threadMessagesRef.current = threadMessages;

  const applyStreamEvent = useCallback(
    (event: ChatStreamEvent) => {
      const openChannelId = currentIdRef.current;
      switch (event.type) {
        case 'message-posted': {
          if (event.channelId !== openChannelId) {
            // Somewhere else. The badge is the reader's own arithmetic, so ask
            // rather than guess.
            void loadChannels();
            return;
          }
          const message = event.message;
          if (message.parentMessageId && message.parentMessageId === threadIdRef.current) {
            setThreadMessages((prev) =>
              prev.some((row) => row.id === message.id) ? prev : [...prev, message],
            );
          }
          setMessages((prev) => {
            if (prev.some((row) => row.id === message.id)) return prev;
            // Every reply bumps its parent's count, including a broadcast one:
            // the count is "replies in this thread", and a reply that also
            // appears in the channel is still a reply.
            const next = message.parentMessageId
              ? prev.map((row) =>
                  row.id === message.parentMessageId
                    ? { ...row, replyCount: row.replyCount + 1 }
                    : row,
                )
              : prev;
            // A thread reply only belongs in the transcript when its author
            // asked for it to be there.
            return !message.parentMessageId || message.threadBroadcast
              ? [...next, message]
              : next;
          });
          if (message.authorMemberId !== myMemberId) {
            const someone = people.find((person) => person.id === myMemberId)?.username;
            if (document.visibilityState === 'hidden' && mentionsCaller(message, myMemberId, someone)) {
              notifyMention(
                message.body,
                current?.displayName ?? currentSlug ?? '',
                currentSlug ? `/${homeView}/${encodeURIComponent(currentSlug)}` : undefined,
                current ? `chat-${current.id}` : undefined,
              );
            }
            // Reading is what the person is doing by having it open; the badge
            // should not creep up while they watch.
            if (document.visibilityState === 'visible' && activeOrgId && currentSlug) {
              void markChatChannelRead(activeOrgId, currentSlug).then(() => loadChannels());
            }
          }
          return;
        }
        case 'message-edited':
        case 'reaction-changed': {
          const message = event.message;
          setMessages((prev) => prev.map((row) => (row.id === message.id ? message : row)));
          setThreadMessages((prev) => prev.map((row) => (row.id === message.id ? message : row)));
          return;
        }
        case 'message-deleted': {
          const parentId =
            messagesRef.current.find((row) => row.id === event.messageId)?.parentMessageId
            ?? threadMessagesRef.current.find((row) => row.id === event.messageId)?.parentMessageId
            ?? null;
          setMessages((prev) =>
            prev
              .filter((row) => row.id !== event.messageId)
              .map((row) =>
                parentId && row.id === parentId
                  ? { ...row, replyCount: Math.max(0, row.replyCount - 1) }
                  : row,
              ),
          );
          setThreadMessages((prev) => prev.filter((row) => row.id !== event.messageId));
          if (threadIdRef.current === event.messageId) setThreadId(null);
          return;
        }
        case 'pin-changed': {
          setMessages((prev) =>
            prev.map((row) => (row.id === event.messageId ? { ...row, pinned: event.pinned } : row)),
          );
          if (event.channelId === openChannelId && activeOrgId && currentSlug) {
            void fetchChatPins(activeOrgId, currentSlug)
              .then((result) => setPins(result.pins))
              .catch(() => {});
          }
          return;
        }
        case 'bookmark-changed': {
          if (event.channelId === openChannelId) setBookmarks(event.bookmarks);
          return;
        }
        case 'channel-created':
        case 'channel-updated':
        case 'channel-archived':
        case 'member-joined':
        case 'member-left':
          void loadChannels();
          return;
        case 'huddle-started':
        case 'huddle-ended':
        case 'huddle-roster':
          void loadChannels();
          if (event.type === 'huddle-roster') huddle.sync(event.huddle);
          return;
        case 'huddle-signal':
          huddle.accept(event.signal);
          return;
        default:
      }
    },
    // `people` and `current` are read for the notification text only; a stale
    // name in a background notification is not worth rebuilding the stream for,
    // which is why the hook holds this in a ref.
    [activeOrgId, currentSlug, current, homeView, loadChannels, myMemberId, people, huddle],
  );

  const resync = useCallback(() => {
    if (!activeOrgId || !currentSlug) return;
    void loadMessages(currentSlug).catch(() => {});
    void loadChannels().catch(() => {});
  }, [activeOrgId, currentSlug, loadChannels, loadMessages]);

  const realtime = useTeamChatRealtime({
    orgId: activeOrgId ?? null,
    active,
    myMemberId,
    onEvent: applyStreamEvent,
    onResync: resync,
  });

  // A fallback, not the mechanism. While the stream is open this does nothing;
  // when it is not — an old browser without EventSource, a proxy that will not
  // hold a connection, a daemon restarting — chat degrades to the refresh rate
  // it had before rather than to silence. Thirty seconds because a fallback
  // that costs as much as the thing it replaces is not a fallback.
  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug) return;
    if (realtime.status === 'open') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadMessages(currentSlug).catch(() => {});
      void loadChannels().catch(() => {});
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [active, activeOrgId, currentSlug, realtime.status, loadChannels, loadMessages]);

  useEffect(() => {
    if (!activeOrgId) {
      setHistorySlugs([]);
      return;
    }
    setHistorySlugs(readChatHistory(activeOrgId));
  }, [activeOrgId]);

  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug) return;
    setHistorySlugs(rememberChatHistory(activeOrgId, currentSlug));
  }, [active, activeOrgId, currentSlug]);

  // A draft is restored from whichever copy is available: the local one is
  // instant and survives a reload with no network, the server one is what
  // makes the reply you started on a laptop appear on a phone. Local wins on
  // load because it is never older — it is written on every keystroke.
  useEffect(() => {
    if (!activeOrgId || !currentSlug) return;
    const key = `${DRAFT_PREFIX}${activeOrgId}:${currentSlug}`;
    const local = window.localStorage.getItem(key);
    const remote = current ? draftsBySlug[current.id] : undefined;
    const restored = local ?? remote ?? '';
    if (restored) setDraft(restored);
  }, [activeOrgId, currentSlug, current, draftsBySlug]);

  useEffect(() => {
    if (!activeOrgId || !currentSlug) return;
    const key = `${DRAFT_PREFIX}${activeOrgId}:${currentSlug}`;
    if (draft.trim()) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  }, [activeOrgId, currentSlug, draft]);

  // The server copy is written on a debounce. Every keystroke would be a
  // request per character; a second and a half is short enough that switching
  // devices mid-sentence works and long enough that typing costs one write.
  useEffect(() => {
    if (!activeOrgId || !currentSlug) return;
    const timer = window.setTimeout(() => {
      void saveChatDraft(activeOrgId, currentSlug, { body: draft, parentMessageId: null }).catch(() => {
        // A draft that fails to sync is still in localStorage. Nothing is lost
        // that an error banner would help with.
      });
    }, DRAFT_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeOrgId, currentSlug, draft]);

  useEffect(() => {
    if (!active || !activeOrgId) return;
    void fetchChatStatuses(activeOrgId)
      .then((result) => setStatuses(result.statuses ?? []))
      .catch(() => setStatuses([]));
  }, [active, activeOrgId, people.length]);

  // Emoji, groups, sections, quiet hours, and any drafts left on another
  // device. All five are per organization and change rarely, so they are
  // fetched once rather than with every channel switch. Each failure is
  // swallowed on its own: a missing emoji list should not cost you your
  // sidebar sections.
  useEffect(() => {
    if (!active || !activeOrgId) return;
    void fetchChatEmoji(activeOrgId).then((r) => setCustomEmoji(r.emoji)).catch(() => setCustomEmoji([]));
    void fetchChatGroups(activeOrgId).then((r) => setGroups(r.groups)).catch(() => setGroups([]));
    void fetchChatSections(activeOrgId).then((r) => setSections(r.sections)).catch(() => setSections([]));
    void fetchChatDnd(activeOrgId)
      .then((r) => {
        setDnd(r.dnd);
        setDndActive(r.active);
      })
      .catch(() => setDnd(null));
    void fetchChatDrafts(activeOrgId)
      .then((r) => {
        const byChannel: Record<string, string> = {};
        for (const item of r.drafts) {
          if (!item.parentMessageId) byChannel[item.channelId] = item.body;
        }
        setDraftsBySlug(byChannel);
      })
      .catch(() => setDraftsBySlug({}));
  }, [active, activeOrgId]);

  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug || pane !== 'channel') return;
    void Promise.all([
      fetchChatPins(activeOrgId, currentSlug).then((result) => setPins(result.pins)).catch(() => setPins([])),
      fetchChatBookmarks(activeOrgId, currentSlug).then((result) => setBookmarks(result.bookmarks)).catch(() => setBookmarks([])),
      fetchChatChannelMembers(activeOrgId, currentSlug).then(setChannelMembers).catch(() => setChannelMembers([])),
    ]);
    setTopicDraft(current?.topic ?? '');
    setPurposeDraft(current?.purpose ?? '');
  }, [active, activeOrgId, currentSlug, pane, current?.topic, current?.purpose]);

  useEffect(() => {
    if (!active || !activeOrgId) return;
    if (pane === 'activity') {
      void fetchChatActivity(activeOrgId).then((result) => setActivity(result.items)).catch(() => setActivity([]));
    }
    if (pane === 'later') {
      void fetchChatLater(activeOrgId).then((result) => setLater(result.items)).catch(() => setLater([]));
    }
    if (pane === 'reminders') {
      void fetchChatReminders(activeOrgId).then((result) => setReminders(result.reminders)).catch(() => setReminders([]));
    }
    if (pane === 'scheduled') {
      void fetchChatScheduled(activeOrgId).then((result) => setScheduled(result.messages)).catch(() => setScheduled([]));
    }
    if (detailsOpen && detailsTab === 'files' && currentSlug) {
      void fetchChatChannelFiles(activeOrgId, currentSlug)
        .then((result) => setChannelFiles(result.files))
        .catch(() => setChannelFiles([]));
    }
  }, [active, activeOrgId, pane, detailsOpen, detailsTab, currentSlug]);

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setJumpOpen((prev) => !prev);
        setSearchOpen(false);
        setShortcutsOpen(false);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setPane('activity');
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        setPane('unreads');
      }
      if (event.key === 'ArrowUp' && typing && event.target === mainComposerRef.current && !draft.trim()) {
        const lastMine = [...messages].reverse().find((message) => message.authorMemberId === myMemberId && !message.system);
        if (lastMine) {
          event.preventDefault();
          setEditingId(lastMine.id);
          setEditDraft(lastMine.body);
        }
      }
      if (event.key === 'Escape') {
        setThreadId(null);
        setEmojiOpen(false);
        setSuggestions([]);
        setSuggestionFor(null);
        setJumpOpen(false);
        setDetailsOpen(false);
        setStatusOpen(false);
        setShortcutsOpen(false);
        setRemindMenu(null);
        setShareId(null);
        setProfileId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, messages, myMemberId]);

  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, currentSlug]);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const node = document.querySelector(`[data-testid="team-message-${hash}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'center' });
  }, [messages]);

  /** The other person in a two-person DM, so the sidebar can show whether they
   * are here rather than a generic message bubble. */
  function dmPartnerId(channel: ChatChannel): string | null {
    if (channel.kind !== 'dm') return null;
    const row = channelMembers.find(
      (member) => member.channelId === channel.id && member.memberId !== myMemberId,
    );
    return row?.memberId ?? null;
  }

  function renderChannelButton(channel: ChatChannel) {
    const selected = pane === 'channel' && current?.id === channel.id;
    const draftKey = activeOrgId ? `${DRAFT_PREFIX}${activeOrgId}:${channel.slug}` : '';
    const hasDraft = Boolean(
      (draftKey && typeof window !== 'undefined' && window.localStorage.getItem(draftKey))
      || draftsBySlug[channel.id],
    );
    const partner = dmPartnerId(channel);
    return (
      <button
        key={channel.id}
        type="button"
        className={`${styles.channelButton}${selected ? ` ${styles.channelActive}` : ''}${channel.unreadCount > 0 ? ` ${styles.channelUnread}` : ''}${channel.muted ? ` ${styles.channelMuted}` : ''}`}
        onClick={() => selectChannel(channel.slug)}
        data-testid={`team-channel-${channel.slug}`}
      >
        {partner ? (
          <i
            className={presenceOf(partner) === 'active' ? styles.presenceOn : styles.presenceOff}
            aria-hidden
          />
        ) : (
          <Icon
            name={
              isDirect(channel)
                ? 'message-circle'
                : channel.visibility === 'private'
                  ? 'lock'
                  : 'hash'
            }
            size={12}
          />
        )}
        <span className={styles.channelName}>{channel.displayName}</span>
        {channel.huddleActive ? (
          <span className={styles.huddleDot} title={t('team.huddleLive')} aria-label={t('team.huddleLive')} />
        ) : null}
        {hasDraft && channel.unreadCount === 0 ? <span className={styles.draftMark}>{t('team.draft')}</span> : null}
        {channel.starred ? <Icon name="star" size={10} /> : null}
        {/* Two badges, because they answer different questions: the red count
            is "you were named", the plain one is "there is something here". */}
        {channel.mentionCount > 0 ? (
          <Badge tone="danger" data-testid={`team-mention-${channel.slug}`}>{channel.mentionCount}</Badge>
        ) : channel.unreadCount > 0 ? (
          <Badge tone="accent" data-testid={`team-unread-${channel.slug}`}>{channel.unreadCount}</Badge>
        ) : null}
      </button>
    );
  }

  /** Channels the sidebar shows outside any custom section. A channel put into
   * a section leaves the default group, which is what makes sections useful
   * rather than a second copy of the same list. */
  const sectioned = useMemo(() => {
    const assigned = new Set(sections.flatMap((section) => section.channelIds));
    return {
      assigned,
      loose: (list: ChatChannel[]) => list.filter((channel) => !assigned.has(channel.id)),
    };
  }, [sections]);

  async function moveToSection(channelId: string, sectionId: string | null) {
    if (!activeOrgId) return;
    try {
      if (sectionId) {
        const target = sections.find((section) => section.id === sectionId);
        if (!target) return;
        setSections(
          await updateChatSection(activeOrgId, sectionId, {
            channelIds: [...new Set([...target.channelIds, channelId])],
          }),
        );
        return;
      }
      const owner = sections.find((section) => section.channelIds.includes(channelId));
      if (!owner) return;
      setSections(
        await updateChatSection(activeOrgId, owner.id, {
          channelIds: owner.channelIds.filter((id) => id !== channelId),
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function selectChannel(slug: string) {
    setPane('channel');
    setCurrentSlug(slug);
    setThreadId(null);
    setSearchOpen(false);
    setSearchHits(null);
    navigate({ kind: 'home', view: homeView, channelId: slug });
  }

  function statusFor(memberId: string | null | undefined): ChatStatus | undefined {
    if (!memberId) return undefined;
    return statuses.find((item) => item.memberId === memberId && item.text);
  }

  /** Whether someone is here right now.
   *
   * This used to be inferred from how recently their read marker moved, which
   * meant somebody who had chat open but had not looked at this channel read
   * as away, and somebody who left the tab open overnight read as present.
   * It is now the connection itself. */
  function isActive(memberId: string | null | undefined): boolean {
    return presenceState(realtime.presence, memberId) === 'active';
  }

  function presenceOf(memberId: string | null | undefined): 'active' | 'away' | 'offline' {
    return presenceState(realtime.presence, memberId);
  }

  async function runSlash(slash: ReturnType<typeof parseSlashCommand>) {
    if (!slash || !activeOrgId || !currentSlug) return;
    try {
      if (slash.name === 'shrug') {
        setDraft(`${slash.rest ? `${slash.rest} ` : ''}¯\\_(ツ)_/¯`);
        return;
      }
      if (slash.name === 'me') {
        setDraft(`_${slash.rest || 'does a thing'}_`);
        return;
      }
      if (slash.name === 'help') {
        setError(SLASH_HELP);
        setDraft('');
        return;
      }
      if (slash.name === 'topic') {
        await updateChatChannel(activeOrgId, currentSlug, { topic: slash.rest });
        setDraft('');
        await loadChannels();
        return;
      }
      if (slash.name === 'purpose') {
        await updateChatChannel(activeOrgId, currentSlug, { purpose: slash.rest });
        setDraft('');
        await loadChannels();
        return;
      }
      if (slash.name === 'mute' || slash.name === 'unmute') {
        await updateChatChannelPrefs(activeOrgId, currentSlug, { muted: slash.name === 'mute' });
        setDraft('');
        await loadChannels();
        return;
      }
      if (slash.name === 'leave') {
        setDraft('');
        await leave();
        return;
      }
      if (slash.name === 'join') {
        setDraft('');
        await join();
        return;
      }
      if (slash.name === 'archive') {
        setDraft('');
        await archiveChatChannel(activeOrgId, currentSlug);
        await loadChannels();
        return;
      }
      if (slash.name === 'unarchive') {
        setDraft('');
        await unarchiveChatChannel(activeOrgId, currentSlug);
        await loadChannels();
        return;
      }
      if (slash.name === 'who') {
        setDraft('');
        setDetailsOpen(true);
        setDetailsTab('members');
        return;
      }
      if (slash.name === 'status') {
        await setMyChatStatus(activeOrgId, { text: slash.rest || null, emoji: slash.rest ? '💬' : null });
        const result = await fetchChatStatuses(activeOrgId);
        setStatuses(result.statuses ?? []);
        setDraft('');
        return;
      }
      if (slash.name === 'away') {
        await setMyChatStatus(activeOrgId, { text: 'Away', emoji: '🌙' });
        const result = await fetchChatStatuses(activeOrgId);
        setStatuses(result.statuses ?? []);
        setDraft('');
        return;
      }
      if (slash.name === 'dnd') {
        await setMyChatStatus(activeOrgId, { text: 'Do not disturb', emoji: '🔕', expiresAt: Date.now() + 30 * 60_000 });
        const result = await fetchChatStatuses(activeOrgId);
        setStatuses(result.statuses ?? []);
        setDraft('');
        return;
      }
      if (slash.name === 'invite') {
        const person = lookupPerson(people, slash.rest);
        if (!person) {
          setError(t('team.noPeople'));
          return;
        }
        await inviteChatMembers(activeOrgId, currentSlug, [person.id]);
        setDraft('');
        await loadChannels();
        return;
      }
      if (slash.name === 'msg') {
        const person = lookupPerson(people, slash.rest);
        if (!person) {
          setError(t('team.noPeople'));
          return;
        }
        const channel = await openChatDirectMessage(activeOrgId, [person.id]);
        setDraft('');
        await loadChannels();
        selectChannel(channel.slug);
        return;
      }
      if (slash.name === 'remind') {
        const latest = [...messages].reverse().find((message) => !message.system);
        if (!latest) return;
        const fireAt = parseRemindWhen(slash.rest) ?? chatWhen('1h');
        await remindChatMessage(activeOrgId, latest.id, fireAt);
        setDraft('');
        return;
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function send(parentMessageId?: string) {
    if (!activeOrgId || !currentSlug) return;
    const text = (parentMessageId ? threadDraft : draft).trim();
    const files = pendingFiles;
    if (!text && files.length === 0) return;
    if (!parentMessageId) {
      const slash = parseSlashCommand(text);
      if (slash) {
        await runSlash(slash);
        return;
      }
    }
    setSending(true);
    setEmojiOpen(false);
    setSuggestions([]);
    setSuggestionFor(null);
    try {
      const attachments: TeamChatAttachment[] = [];
      for (const file of files) {
        if (file.size > CHAT_FILE_MAX_BYTES) {
          setError(t('team.fileTooLarge'));
          setSending(false);
          return;
        }
        attachments.push(await uploadChatFile(activeOrgId, file));
      }
      if (parentMessageId) setThreadDraft('');
      else setDraft('');
      setPendingFiles([]);
      // "Also send to channel" is a property of the one reply, not a second
      // copy of it. Posting twice used to mean an edit could change one and
      // not the other, and a delete could leave the echo behind.
      await postChatMessage(activeOrgId, currentSlug, {
        body: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
        ...(parentMessageId && alsoSend ? { threadBroadcast: true } : {}),
      });
      if (parentMessageId && alsoSend) setAlsoSend(false);
      realtime.notifyTyping(currentSlug, parentMessageId ?? null, false);
      pinnedToBottom.current = true;
      // Normally the posted message arrives on the stream like anyone else's,
      // so there is nothing to refetch. When the stream is not up — no
      // EventSource, a proxy eating the connection — the sender would watch
      // their own message vanish, which is the worst possible way for a chat
      // app to fail. So: fetch when we are not listening.
      if (realtime.status !== 'open') {
        await loadMessages(currentSlug);
        if (parentMessageId) {
          const thread = await fetchChatMessages(activeOrgId, currentSlug, {
            parentMessageId,
            limit: 80,
          });
          setThreadMessages(thread.messages);
        }
      }
      await loadChannels();
      setError(null);
    } catch (err) {
      if (parentMessageId) setThreadDraft(text);
      else setDraft(text);
      setPendingFiles(files);
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  /** Insert a suggestion into whichever composer raised the menu. */
  function chooseSuggestion(
    suggestion: ChatSuggestion,
    text: string,
    setText: (value: string) => void,
    parentMessageId?: string,
  ) {
    const node = parentMessageId ? threadComposerRef.current : mainComposerRef.current;
    const caret = node?.selectionStart ?? text.length;
    const query = readChatAutocomplete(text, caret);
    if (!query) return;
    const next = applyChatSuggestion(text, query, suggestion);
    setText(next.text);
    setSuggestions([]);
    setSuggestionFor(null);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(next.caret, next.caret);
    });
  }

  /** Recompute the menu from the caret. Called on every change and on cursor
   * moves, because moving the caret into an existing `@ada` should offer to
   * complete it just as typing it does. */
  function refreshSuggestions(
    text: string,
    caret: number,
    which: 'main' | 'thread',
  ) {
    const query = readChatAutocomplete(text, caret);
    if (!query) {
      setSuggestions([]);
      setSuggestionFor(null);
      return;
    }
    const next = chatSuggestions(query, {
      people,
      groups,
      channels,
      customEmoji,
      selfMemberId: myMemberId,
    });
    setSuggestions(next);
    setSuggestionIndex(0);
    setSuggestionFor(next.length > 0 ? which : null);
  }

  /** Wrap the selection (or insert a placeholder) in a formatting mark.
   *
   * Operates on the textarea's own selection rather than on React state,
   * because the caret is the thing being formatted and only the DOM knows
   * where it is. */
  function applyFormat(
    mark: string,
    text: string,
    setText: (value: string) => void,
    parentMessageId?: string,
  ) {
    const node = parentMessageId ? threadComposerRef.current : mainComposerRef.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    const next = wrapSelection(text, start, end, mark);
    setText(next);
    // Leave the marked-up run selected, so pressing bold then italic wraps the
    // same words twice instead of nesting them around a collapsed caret.
    const from = start + mark.length;
    const to = from + (end > start ? end - start : 4);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(from, to);
    });
  }

  function onComposerKey(
    event: KeyboardEvent<HTMLTextAreaElement>,
    parentMessageId: string | undefined,
    text: string,
    setText: (value: string) => void,
  ) {
    const which = parentMessageId ? 'thread' : 'main';
    const menuOpen = suggestionFor === which && suggestions.length > 0;

    // The formatting shortcuts everybody expects from a text box. Checked
    // before the suggestion menu, since none of them collide with it.
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase();
      const mark = key === 'b' ? '*' : key === 'i' ? '_' : key === 'x' && event.shiftKey ? '~' : null;
      if (mark) {
        event.preventDefault();
        applyFormat(mark, text, setText, parentMessageId);
        return;
      }
      if (key === 'c' && event.shiftKey) {
        event.preventDefault();
        applyFormat('`', text, setText, parentMessageId);
        return;
      }
    }

    if (menuOpen) {
      // While the menu is up it owns the arrows, tab, and enter. Escape closes
      // it without also closing the thread pane, which is what a bare Escape
      // does — hence handling it here rather than letting it fall through.
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSuggestionIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSuggestionIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const picked = suggestions[suggestionIndex];
        if (picked) {
          event.preventDefault();
          event.stopPropagation();
          chooseSuggestion(picked, text, setText, parentMessageId);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setSuggestions([]);
        setSuggestionFor(null);
        return;
      }
    }

    if (event.key === 'Escape' && emojiOpen) {
      event.preventDefault();
      setEmojiOpen(false);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(parentMessageId);
    }
  }

  function queueFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list).filter((file) => file.size > 0 || file.name);
    if (incoming.length === 0) return;
    if (incoming.some((file) => file.size > CHAT_FILE_MAX_BYTES)) {
      setError(t('team.fileTooLarge'));
      return;
    }
    setPendingFiles((prev) => [...prev, ...incoming].slice(0, 8));
    setError(null);
  }

  function insertAtCursor(
    text: string,
    insertion: string,
    setText: (value: string) => void,
    parentMessageId?: string,
  ) {
    const node = parentMessageId ? threadComposerRef.current : mainComposerRef.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    const next = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
    setText(next);
    const pos = start + insertion.length;
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(pos, pos);
    });
  }

  function onComposerDragOver(event: DragEvent) {
    event.preventDefault();
    setDropping(true);
  }

  function onComposerDragLeave(event: DragEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDropping(false);
  }

  function onComposerDrop(event: DragEvent) {
    event.preventDefault();
    setDropping(false);
    queueFiles(filesFromTransfer(event.dataTransfer));
  }

  function onComposerPaste(event: ClipboardEvent) {
    const files = filesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    queueFiles(files);
  }

  function composerForm(
    text: string,
    setText: (value: string) => void,
    parentMessageId: string | undefined,
    placeholder: string,
    testId?: string,
  ) {
    const pickerKey = parentMessageId ? 'thread' : 'main';
    return (
      <form
        className={`${styles.composer}${dropping ? ` ${styles.composerHot}` : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send(parentMessageId);
        }}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onPaste={onComposerPaste}
      >
        <div className={styles.composerBox} data-testid={testId ? 'team-composer-box' : undefined}>
          {pendingFiles.length > 0 ? (
            <ul className={styles.pending}>
              {pendingFiles.map((file, index) => (
                <PendingChatFile
                  key={`${file.name}-${index}`}
                  file={file}
                  removeLabel={t('team.removeAttachment')}
                  onRemove={() => setPendingFiles((prev) => prev.filter((_, i) => i !== index))}
                />
              ))}
            </ul>
          ) : null}
          {dropping ? <p className={styles.dropHint}>{t('team.dropToAttach')}</p> : null}
          {text.startsWith('/') && !parentMessageId ? <p className={styles.slashHint}>{t('team.slashHint')}</p> : null}
          {suggestionFor === pickerKey && suggestions.length > 0 ? (
            <ul className={styles.mentionList} data-testid="team-suggestions">
              {suggestions.map((suggestion, index) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    className={`${styles.mentionBtn}${index === suggestionIndex ? ` ${styles.mentionBtnActive}` : ''}`}
                    // The menu must not steal focus from the composer: the
                    // caret position is what tells us which token to replace.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSuggestionIndex(index)}
                    onClick={() => chooseSuggestion(suggestion, text, setText, parentMessageId)}
                  >
                    {suggestion.iconUrl ? (
                      <img className={styles.suggestionEmoji} src={suggestion.iconUrl} alt="" />
                    ) : suggestion.icon ? (
                      <span aria-hidden>{suggestion.icon}</span>
                    ) : null}
                    <span className={styles.suggestionLabel}>{suggestion.label}</span>
                    {suggestion.hint ? (
                      <span className={styles.suggestionHint}>{suggestion.hint}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {emojiOpen === pickerKey ? (
            <div className={styles.emojiPicker} data-testid="team-emoji-picker">
              {customEmoji.length > 0 ? (
                <div>
                  <p className={styles.emojiLabel}>{t('team.customEmoji')}</p>
                  <div className={styles.emojiGrid}>
                    {customEmoji
                      .filter((item) => item.url)
                      .map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          className={styles.emojiBtn}
                          title={`:${item.name}:`}
                          onClick={() => {
                            insertAtCursor(text, `:${item.name}: `, setText, parentMessageId);
                            setEmojiOpen(false);
                          }}
                        >
                          <img className={styles.suggestionEmoji} src={item.url!} alt={`:${item.name}:`} />
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}
              {CHAT_EMOJI_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className={styles.emojiLabel}>{group.label}</p>
                  <div className={styles.emojiGrid}>
                    {group.emoji.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className={styles.emojiBtn}
                        onClick={() => {
                          insertAtCursor(text, emoji, setText, parentMessageId);
                          setEmojiOpen(false);
                        }}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <Textarea
            ref={parentMessageId ? threadComposerRef : mainComposerRef}
            value={text}
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              refreshSuggestions(value, event.target.selectionStart ?? value.length, pickerKey);
              // Announcing "typing" for an empty box would say someone is
              // composing when they have just cleared it.
              if (currentSlug) {
                realtime.notifyTyping(currentSlug, parentMessageId ?? null, value.trim().length > 0);
              }
            }}
            onSelect={(event) => {
              const node = event.currentTarget;
              refreshSuggestions(node.value, node.selectionStart ?? node.value.length, pickerKey);
            }}
            onBlur={() => {
              if (currentSlug) realtime.notifyTyping(currentSlug, parentMessageId ?? null, false);
            }}
            onKeyDown={(event) => onComposerKey(event, parentMessageId, text, setText)}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={sending}
            rows={2}
            data-testid={testId}
          />
          <div className={styles.composerBar}>
            <span className={styles.formatBar}>
              {([
                ['*', t('team.bold'), 'B'],
                ['_', t('team.italic'), 'I'],
                ['~', t('team.strike'), 'S'],
                ['`', t('team.code'), '<>'],
              ] as const).map(([mark, label, glyph]) => (
                <button
                  key={mark}
                  type="button"
                  className={styles.formatBtn}
                  aria-label={label}
                  title={label}
                  // Formatting acts on the selection, which a focus change
                  // would collapse before the click handler ever runs.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyFormat(mark, text, setText, parentMessageId)}
                >
                  {glyph}
                </button>
              ))}
            </span>
            <button
              type="button"
              className={styles.attachBtn}
              aria-label={t('team.attachFile')}
              data-testid={testId ? 'team-attach' : undefined}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="attach" size={16} />
            </button>
            <button
              type="button"
              className={styles.attachBtn}
              aria-label={t('team.emoji')}
              data-testid={testId ? 'team-emoji' : undefined}
              onClick={() => setEmojiOpen((prev) => (prev === pickerKey ? false : pickerKey))}
            >
              😊
            </button>
            <Button
              type="submit"
              variant="primary"
              className={styles.sendBtn}
              disabled={sending || (!text.trim() && pendingFiles.length === 0)}
              data-testid={testId ? 'team-send' : undefined}
            >
              {sending ? t('team.sending') : t('team.send')}
            </Button>
          </div>
        </div>
        {parentMessageId ? (
          <label className={styles.privateToggle}>
            <input type="checkbox" checked={alsoSend} onChange={(event) => setAlsoSend(event.target.checked)} />
            {t('team.alsoSendToChannel')}
          </label>
        ) : null}
      </form>
    );
  }

  async function create() {
    if (!activeOrgId) return;
    const name = newChannelName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const channel = await createChatChannel(activeOrgId, {
        displayName: name,
        visibility: newChannelPrivate ? 'private' : 'public',
      });
      setNewChannelName('');
      setCreating(false);
      setNewChannelPrivate(false);
      await loadChannels();
      selectChannel(channel.slug);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function startDm() {
    if (!activeOrgId || dmPicks.length === 0) return;
    setBusy(true);
    try {
      const channel = await openChatDirectMessage(activeOrgId, dmPicks);
      setDmOpen(false);
      setDmPicks([]);
      await loadChannels();
      selectChannel(channel.slug);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function startDmFrom(memberId: string) {
    if (!activeOrgId) return;
    try {
      const channel = await openChatDirectMessage(activeOrgId, [memberId]);
      await loadChannels();
      selectChannel(channel.slug);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function setUp() {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      await setUpChatChannels(activeOrgId);
      const next = await loadChannels();
      setCurrentSlug(next[0]?.slug ?? null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!activeOrgId || !currentSlug) return;
    setBusy(true);
    try {
      await joinChatChannel(activeOrgId, currentSlug);
      await loadChannels();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!activeOrgId || !currentSlug) return;
    setBusy(true);
    try {
      await leaveChatChannel(activeOrgId, currentSlug);
      const next = await loadChannels();
      const fallback = next.find((channel) => channel.joined)?.slug ?? next[0]?.slug ?? null;
      if (fallback) selectChannel(fallback);
      else setCurrentSlug(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSearch(event: FormEvent) {
    event.preventDefault();
    if (!activeOrgId) return;
    const query = searchInput.trim();
    if (!query) {
      setSearchHits(null);
      setSearchOpen(false);
      return;
    }
    try {
      const hits = await searchChatMessages(activeOrgId, query);
      setSearchHits(hits.map((hit) => hit.message));
      setSearchOpen(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function react(messageId: string, emoji: string) {
    if (!activeOrgId) return;
    try {
      await toggleChatReaction(activeOrgId, messageId, emoji);
      if (currentSlug) await loadMessages(currentSlug);
      if (threadId && currentSlug) {
        const thread = await fetchChatMessages(activeOrgId, currentSlug, {
          parentMessageId: threadId,
          limit: 80,
        });
        setThreadMessages(thread.messages);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function togglePin(messageId: string) {
    if (!activeOrgId) return;
    try {
      await toggleChatPin(activeOrgId, messageId);
      if (currentSlug) await loadMessages(currentSlug);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggleSave(messageId: string) {
    if (!activeOrgId) return;
    try {
      await toggleChatSave(activeOrgId, messageId);
      if (currentSlug) await loadMessages(currentSlug);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remind(messageId: string, kind: '20m' | '1h' | 'tomorrow') {
    if (!activeOrgId) return;
    try {
      await remindChatMessage(activeOrgId, messageId, chatWhen(kind));
      setRemindMenu(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** Forward a message somewhere else.
   *
   * This used to paste the body into a new message as a markdown quote, which
   * meant the "quote" was really just text: it could be edited into something
   * the original author never said, and it lost every attachment. The server
   * now stores a snapshot of what was actually said, and renders it as a
   * quotation that cannot be passed off as the reader's own words. */
  async function shareTo(message: TeamChatMessage, slug: string) {
    if (!activeOrgId) return;
    try {
      await forwardChatMessage(activeOrgId, message.id, { toChannel: slug });
      setShareId(null);
      selectChannel(slug);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function markAllRead() {
    if (!activeOrgId) return;
    try {
      await Promise.all(
        channels.filter((channel) => channel.joined && channel.unreadCount > 0).map((channel) =>
          markChatChannelRead(activeOrgId, channel.slug),
        ),
      );
      await loadChannels();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyLink(messageId: string) {
    const url = `${window.location.origin}${window.location.pathname}#${messageId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(url);
    }
  }

  async function markUnread(messageId: string) {
    if (!activeOrgId || !currentSlug) return;
    try {
      await markChatChannelUnread(activeOrgId, currentSlug, messageId);
      await loadChannels();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function saveEdit(messageId: string) {
    if (!activeOrgId) return;
    const body = editDraft.trim();
    if (!body) return;
    try {
      await editChatMessage(activeOrgId, messageId, body);
      setEditingId(null);
      if (currentSlug) await loadMessages(currentSlug);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(messageId: string) {
    if (!activeOrgId) return;
    try {
      await deleteChatMessage(activeOrgId, messageId);
      if (currentSlug) await loadMessages(currentSlug);
      if (threadId === messageId) setThreadId(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function inviteFromDmPicker() {
    if (!activeOrgId || !currentSlug || dmPicks.length === 0) return;
    setBusy(true);
    try {
      await inviteChatMembers(activeOrgId, currentSlug, dmPicks);
      await fetchChatChannelMembers(activeOrgId, currentSlug);
      setDmPicks([]);
      await loadChannels();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function renderMessage(message: TeamChatMessage, inThread = false, grouped = false) {
    const member = people.find((person) => person.id === message.authorMemberId);
    const mine = Boolean(myMemberId && message.authorMemberId === myMemberId);
    const labeled = message.system
      ? t('team.system')
      : labelPerson(member, message.authorName, t('team.someone'));
    const author = !message.system && mine ? t('team.me') : labeled;
    const mentioned = mentionsCaller(message, myMemberId, people.find((person) => person.id === myMemberId)?.username);
    const status = statusFor(message.authorMemberId);
    return (
      <article
        key={message.id}
        id={message.id}
        className={`${styles.message}${message.system ? ` ${styles.systemMessage}` : ''}${grouped ? ` ${styles.messageGrouped}` : ''}${mentioned ? ` ${styles.mentionRow}` : ''}`}
        data-testid={`team-message-${message.id}`}
      >
        {grouped ? (
          <time className={styles.groupedTime}>{formatClock(message.createdAt)}</time>
        ) : (
          <span className={styles.avatarWrap}>
            <PersonAvatar name={labeled} avatarUrl={member?.avatarUrl} className={styles.avatar} />
            <i className={isActive(message.authorMemberId) ? styles.dotOn : styles.dotOff} aria-hidden />
          </span>
        )}
        <div className={styles.messageBody}>
          {grouped ? null : (
            <header className={styles.messageMeta}>
              <button type="button" className={styles.author} onClick={() => setProfileId(message.authorMemberId)}>
                {author}
              </button>
              {status?.text ? <span className={styles.edited}>{status.emoji} {status.text}</span> : null}
              <time>{formatClock(message.createdAt)}</time>
              {message.editedAt ? <span className={styles.edited}>{t('team.edited')}</span> : null}
              {message.pinned ? <Icon name="pin" size={10} /> : null}
            </header>
          )}
          {editingId === message.id ? (
            <form
              className={styles.editRow}
              onSubmit={(event) => {
                event.preventDefault();
                void saveEdit(message.id);
              }}
            >
              <Input value={editDraft} onChange={(event) => setEditDraft(event.target.value)} />
              <Button type="submit">{t('team.save')}</Button>
              <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                {t('team.cancel')}
              </Button>
            </form>
          ) : (
            <ChatMessageBody
              body={message.body}
              attachments={message.attachments}
              onOpenAttachment={openAttachment}
              groups={groups}
              selfHandles={selfHandles}
            />
          )}
          {message.reactions.length > 0 ? (
            <div className={styles.reactions}>
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={reaction.me ? styles.reactionMine : styles.reaction}
                  onClick={() => void react(message.id, reaction.emoji)}
                >
                  {reaction.emoji} {reaction.count}
                </button>
              ))}
            </div>
          ) : null}
          <div className={styles.messageActions}>
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={styles.iconAction}
                aria-label={t('team.addReaction')}
                onClick={() => void react(message.id, emoji)}
              >
                {emoji}
              </button>
            ))}
            {!inThread && !message.system ? (
              <button
                type="button"
                className={styles.iconAction}
                onClick={() => setThreadId(message.parentMessageId ?? message.id)}
              >
                {t('team.replyInThread')}
                {message.replyCount > 0 ? ` (${message.replyCount})` : ''}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => void toggleSave(message.id)}
            >
              {message.saved ? t('team.unsave') : t('team.saveForLater')}
            </button>
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => void togglePin(message.id)}
            >
              {message.pinned ? t('team.unpin') : t('team.pin')}
            </button>
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => void copyLink(message.id)}
            >
              {t('team.copyLink')}
            </button>
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => setRemindMenu((prev) => (prev === message.id ? null : message.id))}
            >
              {t('team.remind')}
            </button>
            {remindMenu === message.id ? (
              <span className={styles.inlineMenu}>
                <button type="button" className={styles.iconAction} onClick={() => void remind(message.id, '20m')}>{t('team.remindIn20m')}</button>
                <button type="button" className={styles.iconAction} onClick={() => void remind(message.id, '1h')}>{t('team.remindIn1h')}</button>
                <button type="button" className={styles.iconAction} onClick={() => void remind(message.id, 'tomorrow')}>{t('team.remindTomorrow')}</button>
              </span>
            ) : null}
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => setShareId((prev) => (prev === message.id ? null : message.id))}
            >
              {t('team.shareTo')}
            </button>
            {shareId === message.id ? (
              <span className={styles.inlineMenu}>
                {rooms.filter((channel) => channel.joined && channel.id !== current?.id).slice(0, 8).map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    className={styles.iconAction}
                    onClick={() => void shareTo(message, channel.slug)}
                  >
                    #{channel.displayName}
                  </button>
                ))}
              </span>
            ) : null}
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => {
                setDraft((prev) => `${prev}${prev ? '\n' : ''}> ${message.body}\n`);
              }}
            >
              {t('team.quote')}
            </button>
            {currentSlug ? (
              <button
                type="button"
                className={styles.iconAction}
                onClick={() => void markUnread(message.id)}
              >
                {t('team.markUnread')}
              </button>
            ) : null}
            {mine && !message.system ? (
              <>
                <button
                  type="button"
                  className={styles.iconAction}
                  onClick={() => {
                    setEditingId(message.id);
                    setEditDraft(message.body);
                  }}
                >
                  {t('team.edit')}
                </button>
                <button
                  type="button"
                  className={styles.iconAction}
                  onClick={() => void remove(message.id)}
                >
                  {t('team.delete')}
                </button>
              </>
            ) : null}
          </div>
          {!inThread && message.replyCount > 0 ? (
            <button type="button" className={styles.threadBar} onClick={() => setThreadId(message.id)}>
              {t('team.threadReplies', { count: String(message.replyCount) })}
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('team.title')} testId="team-chat-view">
        <EmptyState title={t('team.noOrg')} />
      </WorkspacePage>
    );
  }

  if (!loaded) {
    return (
      <div className={styles.root} style={accentVars} data-testid="team-chat-view">
        <Skeleton className={styles.skeleton} />
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <WorkspacePage title={t('team.title')} lead={t('team.lead')} testId="team-chat-view">
        <EmptyState
          title={t('team.setUpTitle')}
          description={t('team.setUpBody')}
          action={
            <Button onClick={() => void setUp()} disabled={busy} data-testid="team-setup">
              {busy ? t('team.settingUp') : t('team.setUpAction')}
            </Button>
          }
        />
      </WorkspacePage>
    );
  }

  const visibleMessages = searchOpen && searchHits ? searchHits : messages;
  const unreadRooms = channels.filter((channel) => channel.joined && channel.unreadCount > 0);

  // Typing rows arrive for every channel on the stream; the indicator only
  // shows the ones for what is on screen, and thread typing belongs in the
  // thread pane rather than under the channel composer.
  const typingHere = realtime.typing.filter(
    (row) => row.channelId === current?.id && !row.parentMessageId,
  );
  const typingInThread = realtime.typing.filter(
    (row) => row.channelId === current?.id && row.parentMessageId === threadId,
  );

  /** "Ada is typing", "Ada and Ravi are typing", "Several people are typing".
   * Names stop at two because a third name makes the line longer than the
   * message it is about. */
  function typingLabel(rows: typeof realtime.typing): string {
    const names = rows
      .map((row) => people.find((person) => person.id === row.memberId))
      .map((person) => (person ? labelPerson(person, person.displayName, t('team.someone')) : null))
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) return t('team.someoneTyping');
    if (names.length === 1) return t('team.oneTyping', { name: names[0]! });
    if (names.length === 2) return t('team.twoTyping', { a: names[0]!, b: names[1]! });
    return t('team.manyTyping');
  }
  const others = people.filter((person) => person.id !== myMemberId);
  const profilePerson = people.find((person) => person.id === profileId);

  return (
    <ChatEmojiProvider emoji={customEmoji}>
    <div className={styles.root} style={accentVars} data-testid="team-chat-view">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.fileInput}
        onChange={(event) => {
          queueFiles(event.target.files);
          event.target.value = '';
        }}
        data-testid="team-file-input"
      />
      {error ? (
        <p className={styles.error} role="alert">{error}</p>
      ) : null}

      <nav className={styles.sidebar} aria-label={t('team.channels')}>
        <button
          type="button"
          className={styles.workspaceName}
          data-testid="team-workspace-name"
          onClick={() => setStatusOpen((prev) => !prev)}
        >
          {workspaceLabel(activeOrg?.name, t('team.workspace'))}
          {dndActive ? <span className={styles.dndMark} title={t('team.quietHours')}>🔕</span> : null}
          {/* Say so when the stream is down, rather than letting the room look
              quiet because nothing is arriving. */}
          {realtime.status === 'reconnecting' || realtime.status === 'closed' ? (
            <span className={styles.offlineMark} data-testid="team-stream-offline">
              {t('team.reconnecting')}
            </span>
          ) : null}
        </button>
        {statusOpen ? (
          <form
            className={styles.createRow}
            onSubmit={(event) => {
              event.preventDefault();
              if (!activeOrgId) return;
              void setMyChatStatus(activeOrgId, { text: statusDraft || null, emoji: statusDraft ? '💬' : null })
                .then(() => fetchChatStatuses(activeOrgId))
                .then((result) => setStatuses(result.statuses ?? []))
                .then(() => setStatusOpen(false))
                .catch((err) => setError(errorMessage(err)));
            }}
          >
            <Input
              value={statusDraft}
              onChange={(event) => setStatusDraft(event.target.value)}
              placeholder={t('team.statusPlaceholder')}
              aria-label={t('team.setStatus')}
            />
            <Button type="submit">{t('team.setStatus')}</Button>
            <Button type="button" variant="ghost" onClick={() => activeOrgId && void setMyChatStatus(activeOrgId, { text: null, emoji: null }).then(() => fetchChatStatuses(activeOrgId)).then((result) => setStatuses(result.statuses ?? [])).then(() => setStatusOpen(false))}>
              {t('team.clearStatus')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => activeOrgId && void setMyChatStatus(activeOrgId, { text: 'Do not disturb', emoji: '🔕', expiresAt: Date.now() + 30 * 60_000 }).then(() => fetchChatStatuses(activeOrgId)).then((result) => setStatuses(result.statuses ?? [])).then(() => setStatusOpen(false))}>
              {t('team.snooze30')}
            </Button>
            {/* A status says what you are doing; quiet hours say whether to
                interrupt you. Related enough to sit together, different enough
                to be separate controls. */}
            <label className={styles.privateToggle}>
              <input
                type="checkbox"
                checked={dnd?.scheduleEnabled ?? false}
                onChange={(event) => {
                  if (!activeOrgId) return;
                  void updateChatDnd(activeOrgId, {
                    scheduleEnabled: event.target.checked,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  })
                    .then((result) => {
                      setDnd(result.dnd);
                      setDndActive(result.active);
                    })
                    .catch((err) => setError(errorMessage(err)));
                }}
              />
              {t('team.quietHours')}
            </label>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!activeOrgId) return;
                const snoozed = Boolean(dnd?.snoozeUntil && dnd.snoozeUntil > Date.now());
                void updateChatDnd(activeOrgId, {
                  snoozeUntil: snoozed ? null : Date.now() + 60 * 60_000,
                })
                  .then((result) => {
                    setDnd(result.dnd);
                    setDndActive(result.active);
                  })
                  .catch((err) => setError(errorMessage(err)));
              }}
            >
              {dnd?.snoozeUntil && dnd.snoozeUntil > Date.now()
                ? t('team.resumeNotifications')
                : t('team.pauseNotifications')}
            </Button>
          </form>
        ) : null}
        <form className={styles.search} onSubmit={(event) => void onSearch(event)}>
          <Icon name="search" size={14} />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('team.searchPlaceholder')}
            aria-label={t('team.search')}
          />
        </form>

        <button type="button" className={`${styles.channelButton}${pane === 'channel' && !searchOpen ? ` ${styles.channelActive}` : ''}`} onClick={() => { setPane('channel'); setSearchOpen(false); }}>
          <Icon name="home" size={12} />
          <span className={styles.channelName}>{t('team.home')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'unreads' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('unreads')} data-testid="team-unreads">
          <Icon name="message-circle" size={12} />
          <span className={styles.channelName}>{t('team.unreads')}</span>
          {unreadRooms.length > 0 ? <Badge tone="accent">{unreadRooms.reduce((sum, channel) => sum + channel.unreadCount, 0)}</Badge> : null}
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'dms' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('dms')}>
          <Icon name="message-circle" size={12} />
          <span className={styles.channelName}>{t('team.dms')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'activity' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('activity')} data-testid="team-activity">
          <Icon name="bell" size={12} />
          <span className={styles.channelName}>{t('team.activity')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'later' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('later')} data-testid="team-later">
          <Icon name="bookmark" size={12} />
          <span className={styles.channelName}>{t('team.later')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'history' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('history')} data-testid="team-history">
          <Icon name="history" size={12} />
          <span className={styles.channelName}>{t('team.history')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'reminders' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('reminders')} data-testid="team-reminders">
          <Icon name="bell" size={12} />
          <span className={styles.channelName}>{t('team.reminders')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'scheduled' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('scheduled')}>
          <Icon name="send" size={12} />
          <span className={styles.channelName}>{t('team.scheduled')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'browse' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('browse')}>
          <Icon name="hash" size={12} />
          <span className={styles.channelName}>{t('team.browseChannels')}</span>
        </button>
        <button type="button" className={styles.channelButton} onClick={() => void markAllRead()}>
          <Icon name="check" size={12} />
          <span className={styles.channelName}>{t('team.markAllRead')}</span>
        </button>
        <button
          type="button"
          className={styles.channelButton}
          onClick={() => {
            if (notifyPermission === 'granted' || notifyPermission === 'unsupported') return;
            void enableChatPush().then(setNotifyPermission);
          }}
        >
          <Icon name="bell" size={12} />
          <span className={styles.channelName}>
            {notifyPermission === 'granted'
              ? t('team.notificationsOn')
              : notifyPermission === 'denied'
                ? t('team.notificationsDenied')
                : t('team.enableNotifications')}
          </span>
        </button>
        <button type="button" className={styles.channelButton} onClick={() => setShortcutsOpen(true)}>
          <Icon name="help-circle" size={12} />
          <span className={styles.channelName}>{t('team.shortcuts')}</span>
        </button>

        {starredRooms.length > 0 ? (
          <>
            <div className={styles.sidebarHead}>
              <button type="button" className={styles.sectionLabel} onClick={() => setHideStarred((prev) => !prev)}>{t('team.starred')}</button>
            </div>
            {hideStarred ? null : starredRooms.map((channel) => renderChannelButton(channel))}
          </>
        ) : null}

        {sections.map((section) => {
          const inSection = channels.filter((channel) => section.channelIds.includes(channel.id));
          return (
            <div key={section.id}>
              <div className={styles.sidebarHead}>
                <button
                  type="button"
                  className={styles.sectionLabel}
                  onClick={() =>
                    activeOrgId
                    && void updateChatSection(activeOrgId, section.id, { collapsed: !section.collapsed })
                      .then(setSections)
                      .catch((err) => setError(errorMessage(err)))
                  }
                >
                  {section.emoji ? `${section.emoji} ` : ''}
                  {section.name}
                </button>
                <button
                  type="button"
                  className={styles.ghostIcon}
                  aria-label={t('team.deleteSection')}
                  onClick={() =>
                    activeOrgId
                    && void deleteChatSection(activeOrgId, section.id)
                      .then(() => fetchChatSections(activeOrgId))
                      .then((result) => setSections(result.sections))
                      .catch((err) => setError(errorMessage(err)))
                  }
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
              {section.collapsed
                ? null
                : inSection.length === 0
                  ? <p className={styles.sidebarEmpty}>{t('team.sectionEmpty')}</p>
                  : inSection.map((channel) => renderChannelButton(channel))}
            </div>
          );
        })}

        <div className={styles.sidebarHead}>
          <button type="button" className={styles.sectionLabel} onClick={() => setHideChannels((prev) => !prev)}>{t('team.channels')}</button>
          <button
            type="button"
            className={styles.ghostIcon}
            data-testid="team-new-channel"
            aria-label={t('team.newChannel')}
            onClick={() => {
              setCreating((prev) => !prev);
              setDmOpen(false);
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {creating ? (
          <form
            className={styles.createRow}
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <Input
              value={newChannelName}
              onChange={(event) => setNewChannelName(event.target.value)}
              placeholder={t('team.channelNamePlaceholder')}
              aria-label={t('team.channelNamePlaceholder')}
              data-testid="team-channel-name"
            />
            <label className={styles.privateToggle}>
              <input
                type="checkbox"
                checked={newChannelPrivate}
                onChange={(event) => setNewChannelPrivate(event.target.checked)}
              />
              {t('team.private')}
            </label>
            <Button type="submit" disabled={busy || !newChannelName.trim()}>{t('team.create')}</Button>
          </form>
        ) : null}
        {hideChannels ? null : sectioned.loose(rooms).map((channel) => renderChannelButton(channel))}
        <form
          className={styles.createRow}
          onSubmit={(event) => {
            event.preventDefault();
            const name = newSectionName.trim();
            if (!activeOrgId || !name) return;
            void createChatSection(activeOrgId, { name })
              .then(() => fetchChatSections(activeOrgId))
              .then((result) => {
                setSections(result.sections);
                setNewSectionName('');
              })
              .catch((err) => setError(errorMessage(err)));
          }}
        >
          <Input
            value={newSectionName}
            onChange={(event) => setNewSectionName(event.target.value)}
            placeholder={t('team.newSection')}
            aria-label={t('team.newSection')}
          />
        </form>

        <div className={styles.sidebarHead}>
          <button type="button" className={styles.sectionLabel} onClick={() => setHideDms((prev) => !prev)}>{t('team.directMessages')}</button>
          <button
            type="button"
            className={styles.ghostIcon}
            aria-label={t('team.newDm')}
            onClick={() => {
              setDmOpen((prev) => !prev);
              setCreating(false);
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {dmOpen ? (
          <div className={styles.createRow}>
            {others.length === 0 ? (
              <p className={styles.sidebarEmpty}>{t('team.noPeople')}</p>
            ) : others.map((person) => (
              <label key={person.id} className={styles.personPick}>
                <input
                  type="checkbox"
                  checked={dmPicks.includes(person.id)}
                  onChange={(event) => {
                    setDmPicks((prev) =>
                      event.target.checked ? [...prev, person.id] : prev.filter((id) => id !== person.id),
                    );
                  }}
                />
                {labelPerson(person, person.displayName, t('team.someone'))}
              </label>
            ))}
            <Button disabled={busy || dmPicks.length === 0} onClick={() => void startDm()}>
              {t('team.openDm')}
            </Button>
            {current?.joined ? (
              <Button
                variant="ghost"
                disabled={busy || dmPicks.length === 0}
                onClick={() => void inviteFromDmPicker()}
              >
                {t('team.invite')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {hideDms ? null : sectioned.loose(dms).map((channel) => renderChannelButton(channel))}
      </nav>

      <section className={styles.main} aria-label={current ? current.displayName : t('team.title')}>
        {jumpOpen ? (
          <div className={styles.jump} data-testid="team-jump">
            <Input
              value={jumpQuery}
              onChange={(event) => setJumpQuery(event.target.value)}
              placeholder={t('team.jumpTo')}
              aria-label={t('team.jumpTo')}
              autoFocus
            />
            <ul>
              {channels.filter((channel) =>
                !jumpQuery.trim()
                || channel.displayName.toLowerCase().includes(jumpQuery.toLowerCase())
                || channel.slug.toLowerCase().includes(jumpQuery.toLowerCase()),
              ).slice(0, 12).map((channel) => (
                <li key={channel.id}>
                  <button type="button" className={styles.jumpItem} onClick={() => { selectChannel(channel.slug); setJumpOpen(false); setJumpQuery(''); }}>
                    {isDirect(channel) ? '' : '#'}{channel.displayName}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {copied ? <p className={styles.copied}>{t('team.linkCopied')}</p> : null}
        {shortcutsOpen ? (
          <div className={styles.jump} data-testid="team-shortcuts">
            <h2 className={styles.channelTitle}>{t('team.shortcuts')}</h2>
            <p className={styles.topic}>{t('team.shortcutsBody')}</p>
          </div>
        ) : null}
        {profilePerson ? (
          <div className={styles.jump}>
            <h2 className={styles.channelTitle}>{labelPerson(profilePerson, profilePerson.displayName, t('team.someone'))}</h2>
            <p className={styles.topic}>{isActive(profilePerson.id) ? t('team.active') : t('team.away')}</p>
            {statusFor(profilePerson.id)?.text ? <p className={styles.topic}>{statusFor(profilePerson.id)?.emoji} {statusFor(profilePerson.id)?.text}</p> : null}
            <Button onClick={() => { void startDmFrom(profilePerson.id); setProfileId(null); }}>{t('team.openDm')}</Button>
            <Button variant="ghost" onClick={() => setProfileId(null)}>{t('team.closeDetails')}</Button>
          </div>
        ) : null}
        {pane === 'unreads' ? (
          <>
            <header className={styles.channelHead}>
              <h2 className={styles.channelTitle}>{t('team.unreads')}</h2>
              <Button variant="ghost" onClick={() => void markAllRead()}>{t('team.markAllRead')}</Button>
            </header>
            <div className={styles.transcript} data-testid="team-unreads-list">
              {unreadRooms.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noMessages')}</p> : unreadRooms.map((channel) => (
                <button key={channel.id} type="button" className={styles.activityItem} onClick={() => selectChannel(channel.slug)}>
                  <strong>{isDirect(channel) ? '' : '#'}{channel.displayName}</strong>
                  <em>{channel.unreadCount}</em>
                </button>
              ))}
            </div>
          </>
        ) : pane === 'dms' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.dms')}</h2></header>
            <div className={styles.transcript}>
              {dms.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noPeople')}</p> : dms.map((channel) => (
                <button key={channel.id} type="button" className={styles.activityItem} onClick={() => selectChannel(channel.slug)}>
                  <strong>{channel.displayName}</strong>
                  <em>{channel.unreadCount > 0 ? String(channel.unreadCount) : channel.topic || ''}</em>
                </button>
              ))}
            </div>
          </>
        ) : pane === 'activity' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.activity')}</h2></header>
            <div className={styles.transcript} data-testid="team-activity-list">
              {activity.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noActivity')}</p> : activity.map((item) => (
                <button key={`${item.kind}-${item.message.id}-${item.createdAt}`} type="button" className={styles.activityItem} onClick={() => { selectChannel(item.channelSlug); setThreadId(item.message.parentMessageId ?? item.message.id); }}>
                  <strong>{item.kind === 'mention' ? t('team.mentionedYou') : item.kind === 'reaction' ? t('team.reacted') : item.kind === 'reminder' ? t('team.reminderDue') : t('team.replied')}</strong>
                  <span>#{item.channelName}</span>
                  <em>{item.message.body}</em>
                </button>
              ))}
            </div>
          </>
        ) : pane === 'later' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.later')}</h2></header>
            <div className={styles.transcript}>
              {later.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noSaved')}</p> : later.map((hit) => (
                <button key={hit.message.id} type="button" className={styles.activityItem} onClick={() => selectChannel(hit.channelSlug)}>
                  <strong>#{hit.channelName}</strong>
                  <em>{hit.message.body}</em>
                </button>
              ))}
            </div>
          </>
        ) : pane === 'history' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.history')}</h2></header>
            <div className={styles.transcript} data-testid="team-history-list">
              {historyRooms.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noHistory')}</p> : historyRooms.map((channel) => (
                <button key={channel.id} type="button" className={styles.activityItem} onClick={() => selectChannel(channel.slug)}>
                  <strong>{isDirect(channel) ? '' : '#'}{channel.displayName}</strong>
                  <em>{channel.topic || formatClock(channel.lastMessageAt ?? channel.updatedAt)}</em>
                </button>
              ))}
            </div>
          </>
        ) : pane === 'reminders' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.reminders')}</h2></header>
            <div className={styles.transcript} data-testid="team-reminders-list">
              {reminders.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noReminders')}</p> : reminders.map((reminder) => (
                <div key={reminder.id} className={styles.activityItem}>
                  <button type="button" className={styles.mentionBtn} onClick={() => selectChannel(reminder.channelSlug)}>
                    <strong>#{reminder.channelName}</strong>
                    <em>{formatClock(reminder.fireAt)} — {reminder.message.body}</em>
                  </button>
                  <Button variant="ghost" onClick={() => activeOrgId && void cancelChatReminder(activeOrgId, reminder.id).then(() => fetchChatReminders(activeOrgId)).then((result) => setReminders(result.reminders))}>
                    {t('team.cancelReminder')}
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : pane === 'scheduled' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.scheduled')}</h2></header>
            <div className={styles.transcript}>
              {scheduled.length === 0 ? <p className={styles.emptyTranscript}>{t('team.noScheduled')}</p> : scheduled.map((item) => (
                <div key={item.id} className={styles.activityItem}>
                  <strong>#{item.channelName}</strong>
                  <em>{formatClock(item.sendAt)} — {item.body}</em>
                  <Button variant="ghost" onClick={() => activeOrgId && void cancelChatScheduled(activeOrgId, item.id).then(() => fetchChatScheduled(activeOrgId)).then((result) => setScheduled(result.messages))}>
                    {t('team.cancelSend')}
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : pane === 'browse' ? (
          <>
            <header className={styles.channelHead}><h2 className={styles.channelTitle}>{t('team.browseTitle')}</h2></header>
            <div className={styles.transcript}>
              {rooms.length === 0 ? <p className={styles.emptyTranscript}>{t('team.browseEmpty')}</p> : rooms.map((channel) => (
                <button key={channel.id} type="button" className={styles.activityItem} onClick={() => selectChannel(channel.slug)}>
                  <strong>#{channel.displayName}</strong>
                  <em>{channel.topic || channel.purpose || t('team.join')}</em>
                </button>
              ))}
            </div>
          </>
        ) : !current && !searchOpen ? (
          <EmptyState title={t('team.noSelection')} description={t('team.noSelectionBody')} />
        ) : (
          <>
            <header className={styles.channelHead}>
              <div>
                <h2 className={styles.channelTitle}>
                  {searchOpen
                    ? t('team.search')
                    : current
                      ? `${isDirect(current) ? '' : '#'}${current.displayName}`
                      : t('team.title')}
                </h2>
                {current?.topic && !searchOpen ? <p className={styles.topic}>{current.topic}</p> : null}
              </div>
              <div className={styles.headerActions}>
                {current && !searchOpen ? (
                  <button
                    type="button"
                    className={styles.ghostIcon}
                    aria-label={t('team.searchInChannel')}
                    onClick={() => {
                      setSearchInput(`in:${current.slug} `);
                      setSearchOpen(false);
                    }}
                  >
                    <Icon name="search" size={14} />
                  </button>
                ) : null}
                {current && !current.joined ? (
                  <Button onClick={() => void join()} disabled={busy} data-testid="team-join">
                    {t('team.join')}
                  </Button>
                ) : null}
                {current?.joined ? (
                  <>
                    <button type="button" className={styles.ghostIcon} aria-label={t('team.star')} onClick={() => activeOrgId && currentSlug && void updateChatChannelPrefs(activeOrgId, currentSlug, { starred: !current.starred }).then(loadChannels)}>
                      <Icon name="star" size={14} />
                    </button>
                    <button type="button" className={styles.ghostIcon} aria-label={t('team.mute')} onClick={() => activeOrgId && currentSlug && void updateChatChannelPrefs(activeOrgId, currentSlug, { muted: !current.muted }).then(loadChannels)}>
                      <Icon name="bell" size={14} />
                    </button>
                    <button type="button" className={styles.ghostIcon} aria-label={t('team.details')} onClick={() => setDetailsOpen((prev) => !prev)}>
                      <Icon name="info" size={14} />
                    </button>
                  </>
                ) : null}
                {current?.joined && current.kind === 'channel' ? (
                  <Button variant="ghost" onClick={() => void leave()} disabled={busy}>
                    {t('team.leave')}
                  </Button>
                ) : null}
              </div>
            </header>
            {bookmarks.length > 0 ? (
              <div className={styles.bookmarks}>
                {bookmarks.map((bookmark) => (
                  <span key={bookmark.id} className={styles.bookmarkChip}>
                    <a href={bookmark.url} target="_blank" rel="noreferrer">{bookmark.emoji} {bookmark.label}</a>
                    <button
                      type="button"
                      className={styles.pendingRemove}
                      aria-label={t('team.removeBookmark')}
                      onClick={() => {
                        if (!activeOrgId || !currentSlug) return;
                        void deleteChatBookmark(activeOrgId, bookmark.id)
                          .then(() => fetchChatBookmarks(activeOrgId, currentSlug))
                          .then((result) => setBookmarks(result.bookmarks));
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {current?.joined && !searchOpen ? (
              <div className={styles.huddleBar} data-testid="team-huddle-bar">
                {huddle.huddle && huddle.huddle.channelId === current.id ? (
                  <>
                    <span className={styles.huddleLive}>
                      <span className={styles.huddleDot} aria-hidden />
                      {t('team.huddleInProgress', {
                        count: String(huddle.huddle.participants.length),
                      })}
                    </span>
                    <span className={styles.huddleFaces}>
                      {huddle.huddle.participants.map((participant) => (
                        <span
                          key={participant.memberId}
                          className={participant.muted ? styles.huddleFaceMuted : styles.huddleFace}
                          title={participant.displayName ?? participant.memberId}
                        >
                          {(participant.displayName ?? '?').slice(0, 1).toUpperCase()}
                        </span>
                      ))}
                    </span>
                    <Button variant="ghost" onClick={() => void huddle.toggleMute()}>
                      {huddle.muted ? t('team.huddleUnmute') : t('team.huddleMute')}
                    </Button>
                    <Button variant="ghost" onClick={() => void huddle.leave()} data-testid="team-huddle-leave">
                      {t('team.huddleLeave')}
                    </Button>
                  </>
                ) : (
                  <>
                    {current.huddleActive ? (
                      <span className={styles.huddleLive}>
                        <span className={styles.huddleDot} aria-hidden />
                        {t('team.huddleLive')}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={huddle.joining}
                      onClick={() => currentSlug && void huddle.join(currentSlug)}
                      data-testid="team-huddle-join"
                    >
                      {current.huddleActive ? t('team.huddleJoin') : t('team.huddleStart')}
                    </Button>
                  </>
                )}
                {huddle.error ? <span className={styles.huddleError}>{huddle.error}</span> : null}
              </div>
            ) : null}
            <div
              className={styles.transcript}
              ref={transcriptRef}
              onScroll={(event) => {
                const node = event.currentTarget;
                const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                pinnedToBottom.current = bottom;
                setAtBottom(bottom);
              }}
              data-testid="team-transcript"
            >
              {nextBefore && currentSlug ? (
                <button type="button" className={styles.loadOlder} onClick={() => void loadMessages(currentSlug, nextBefore)}>
                  {t('team.loadOlder')}
                </button>
              ) : null}
              {visibleMessages.length === 0 ? (
                <p className={styles.emptyTranscript}>
                  {searchOpen ? t('team.emptySearch') : t('team.noMessages')}
                </p>
              ) : (
                visibleMessages.map((message, index) => {
                  const prev = visibleMessages[index - 1];
                  const day = new Date(message.createdAt).toDateString();
                  const prevDay = prev ? new Date(prev.createdAt).toDateString() : '';
                  const grouped = Boolean(
                    prev
                    && prev.authorMemberId === message.authorMemberId
                    && !message.system
                    && !prev.system
                    && message.createdAt - prev.createdAt < 5 * 60_000
                    && day === prevDay,
                  );
                  const showUnread = Boolean(
                    unreadAfter
                    && message.createdAt > unreadAfter
                    && (!prev || prev.createdAt <= unreadAfter),
                  );
                  return (
                    <div key={message.id}>
                      {day !== prevDay ? <p className={styles.dayDivider}>{day}</p> : null}
                      {showUnread ? <p className={styles.unreadDivider} data-testid="team-unread-divider">{t('team.unreadDivider')}</p> : null}
                      {renderMessage(message, false, grouped)}
                    </div>
                  );
                })
              )}
            </div>
            {!atBottom ? (
              <button type="button" className={styles.jumpLatest} onClick={() => {
                pinnedToBottom.current = true;
                setAtBottom(true);
                const node = transcriptRef.current;
                if (node) node.scrollTop = node.scrollHeight;
              }}>
                {t('team.jumpLatest')}
              </button>
            ) : null}
            {typingHere.length > 0 ? (
              <p className={styles.typing} data-testid="team-typing">
                {typingLabel(typingHere)}
              </p>
            ) : null}
            {!searchOpen && current
              ? composerForm(
                  draft,
                  setDraft,
                  undefined,
                  t('team.messagePlaceholder', { channel: current.displayName }),
                  'team-composer',
                )
              : null}
          </>
        )}
      </section>

      {detailsOpen && current ? (
        <aside className={styles.detailsPane} aria-label={t('team.details')}>
          <header className={styles.threadHead}>
            <h2>{t('team.details')}</h2>
            <Button variant="ghost" onClick={() => setDetailsOpen(false)}>{t('team.closeDetails')}</Button>
          </header>
          <div className={styles.detailsTabs}>
            {(['about', 'members', 'files', 'pins'] as const).map((tab) => (
              <button key={tab} type="button" className={detailsTab === tab ? styles.tabActive : styles.tab} onClick={() => setDetailsTab(tab)}>
                {t(`team.${tab}` as 'team.about')}
              </button>
            ))}
          </div>
          <div className={styles.transcript}>
            {detailsTab === 'about' ? (
              <form className={styles.aboutForm} onSubmit={(event) => {
                event.preventDefault();
                if (!activeOrgId || !currentSlug) return;
                void updateChatChannel(activeOrgId, currentSlug, { topic: topicDraft, purpose: purposeDraft }).then(loadChannels);
              }}>
                <label>
                  {t('team.setTopic')}
                  <Input value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} placeholder={t('team.topicPlaceholder')} />
                </label>
                <label>
                  {t('team.setPurpose')}
                  <Input value={purposeDraft} onChange={(event) => setPurposeDraft(event.target.value)} placeholder={t('team.purposePlaceholder')} />
                </label>
                <Button type="submit">{t('team.save')}</Button>
                <label className={styles.privateToggle}>
                  {t('team.channelPref')}
                  <select
                    value={current.notify}
                    onChange={(event) => activeOrgId && currentSlug && void updateChatChannelPrefs(activeOrgId, currentSlug, { notify: event.target.value as 'all' | 'mentions' | 'nothing' }).then(loadChannels)}
                  >
                    <option value="all">{t('team.notifyAll')}</option>
                    <option value="mentions">{t('team.notifyMentions')}</option>
                    <option value="nothing">{t('team.notifyNothing')}</option>
                  </select>
                </label>
                {/* Where this channel sits in your own sidebar. Per viewer, so
                    it is a preference rather than a change to the channel. */}
                <label className={styles.privateToggle}>
                  {t('team.section')}
                  <select
                    value={current.sectionId ?? ''}
                    onChange={(event) =>
                      void moveToSection(current.id, event.target.value || null).then(loadChannels)
                    }
                  >
                    <option value="">{t('team.noSection')}</option>
                    {sections.map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.emoji ? `${section.emoji} ` : ''}
                        {section.name}
                      </option>
                    ))}
                  </select>
                </label>
                {isOrgAdmin ? (
                  <label className={styles.privateToggle}>
                    {t('team.whoCanPost')}
                    <select
                      value={current.postPolicy}
                      onChange={(event) =>
                        activeOrgId
                        && currentSlug
                        && void updateChatChannel(activeOrgId, currentSlug, {
                          postPolicy: event.target.value as 'everyone' | 'admins',
                        })
                          .then(loadChannels)
                          .catch((err) => setError(errorMessage(err)))
                      }
                    >
                      <option value="everyone">{t('team.postEveryone')}</option>
                      <option value="admins">{t('team.postAdmins')}</option>
                    </select>
                  </label>
                ) : null}
                {current.kind === 'channel' ? (
                  current.archivedAt ? (
                    <Button variant="ghost" onClick={() => activeOrgId && currentSlug && void unarchiveChatChannel(activeOrgId, currentSlug).then(loadChannels)}>
                      {t('team.unarchive')}
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={() => activeOrgId && currentSlug && void archiveChatChannel(activeOrgId, currentSlug).then(loadChannels)}>
                      {t('team.archive')}
                    </Button>
                  )
                ) : null}
              </form>
            ) : null}
            {detailsTab === 'members' ? (
              <ul className={styles.memberList}>
                {channelMembers.map((member) => (
                  <li key={member.id}>
                    {member.displayName || member.memberId}
                    {isActive(member.memberId) ? ` · ${t('team.active')}` : ` · ${t('team.away')}`}
                    {statusFor(member.memberId)?.text ? ` · ${statusFor(member.memberId)?.emoji ?? ''} ${statusFor(member.memberId)?.text}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {detailsTab === 'files' ? (
              channelFiles.length === 0 ? <p>{t('team.noFiles')}</p> : (
                <ul className={styles.memberList}>
                  {channelFiles.map((file) => {
                    const source = attachmentFileSource(file);
                    return (
                      <li key={file.id}>
                        {source ? (
                          <button
                            type="button"
                            className={styles.fileOpen}
                            onClick={() => setViewingFile(source)}
                          >
                            {file.label}
                          </button>
                        ) : (
                          <a href={file.url} target="_blank" rel="noreferrer">{file.label}</a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}
            {detailsTab === 'pins' ? (
              pins.length === 0 ? <p>{t('team.noPins')}</p> : pins.map((pin) => (
                <article key={pin.id} className={styles.message}>{pin.message.body}</article>
              ))
            ) : null}
            <form className={styles.createRow} onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const label = (form.elements.namedItem('bookmark-label') as HTMLInputElement | null)?.value ?? '';
              const url = (form.elements.namedItem('bookmark-url') as HTMLInputElement | null)?.value ?? '';
              if (!activeOrgId || !currentSlug || !label || !url) return;
              void createChatBookmark(activeOrgId, currentSlug, { label, url })
                .then(() => fetchChatBookmarks(activeOrgId, currentSlug))
                .then((result) => setBookmarks(result.bookmarks));
            }}>
              <p>{t('team.bookmarkAdd')}</p>
              <Input name="bookmark-label" placeholder={t('team.bookmarkAdd')} />
              <Input name="bookmark-url" placeholder="https://" />
              <Button type="submit">{t('team.create')}</Button>
            </form>
          </div>
        </aside>
      ) : null}

      {threadId && current ? (
        <aside className={styles.threadPane} aria-label={t('team.thread')}>
          <header className={styles.threadHead}>
            <h2>{t('team.thread')}</h2>
            <Button variant="ghost" onClick={() => setThreadId(null)}>{t('team.closeThread')}</Button>
          </header>
          <div className={styles.transcript}>
            {parentInThread && !threadMessages.some((message) => message.id === parentInThread.id)
              ? renderMessage(parentInThread, true)
              : null}
            {threadMessages.map((message) => renderMessage(message, true))}
          </div>
          {typingInThread.length > 0 ? (
            <p className={styles.typing}>{typingLabel(typingInThread)}</p>
          ) : null}
          {composerForm(threadDraft, setThreadDraft, threadId, t('team.replyInThread'))}
        </aside>
      ) : null}

      {viewingFile ? (
        <ChatFileLightbox source={viewingFile} onClose={() => setViewingFile(null)} />
      ) : null}
    </div>
    </ChatEmojiProvider>
  );
}
