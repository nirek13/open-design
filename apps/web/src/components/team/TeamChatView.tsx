// In-app Slack-style workspace chat. Messages live in the organization
// database so teammates can coordinate here — this is not a connector to
// Slack.com. Opening a channel marks it read; posting does not. New messages
// arrive by polling while the tab is visible.

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
  personLabel,
  workspaceLabel,
  type ChatActivityItem,
  type ChatBookmark,
  type ChatChannel,
  type ChatPin,
  type ChatReminder,
  type ChatScheduledMessage,
  type ChatSearchHit,
  type ChatStatus,
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
} from '../../providers/registry';
import { navigate } from '../../router';
import {
  chatAccentCssVars,
  chatFileKind,
  DEFAULT_CHAT_ACCENT,
  formatChatFileSize,
  parseChatAccent,
  type ChatAccent,
} from '../../runtime/chat-media';
import { chatWhen, parseRemindWhen, parseSlashCommand, SLASH_HELP, wrapSelection } from '../../runtime/chat-format';
import { CHAT_EMOJI_GROUPS, QUICK_REACTIONS } from '../../runtime/chat-emoji';
import { Icon } from '../Icon';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { ChatMessageBody } from './ChatMessageBody';
import styles from './TeamChatView.module.css';

interface Props {
  active: boolean;
  initialChannelId?: string;
  homeView?: 'team' | 'slack';
}

const POLL_MS = 5_000;
const DRAFT_PREFIX = 'od:chat-draft:';

type ChatPane = 'channel' | 'unreads' | 'dms' | 'activity' | 'later' | 'browse' | 'reminders' | 'scheduled';

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

function notifyMention(body: string, channelName: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(channelName, { body: body.slice(0, 140), silent: false });
  } catch {
    // Browser may still throw if the user revoked permission mid-session.
  }
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

function PendingThumb({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!src) return null;
  return <img src={src} alt="" className={styles.pendingThumb} />;
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
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dropping, setDropping] = useState(false);
  const [accent, setAccent] = useState<ChatAccent>(DEFAULT_CHAT_ACCENT);
  const [pane, setPane] = useState<ChatPane>('channel');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<'about' | 'members' | 'files' | 'pins'>('about');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [hideStarred, setHideStarred] = useState(false);
  const [hideChannels, setHideChannels] = useState(false);
  const [hideDms, setHideDms] = useState(false);
  const [scheduledOk, setScheduledOk] = useState(false);
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

  const openAppAttachment = useCallback(
    async (attachment: TeamChatAttachment) => {
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

  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug) return;
    const tick = async () => {
      try {
        const result = await fetchChatMessages(activeOrgId, currentSlug, { limit: 80 });
        const latest = result.messages[result.messages.length - 1];
        if (
          latest
          && document.visibilityState === 'hidden'
          && lastNotifiedId.current !== latest.id
          && latest.authorMemberId !== myMemberId
          && mentionsCaller(latest, myMemberId, people.find((person) => person.id === myMemberId)?.username)
        ) {
          lastNotifiedId.current = latest.id;
          notifyMention(latest.body, current?.displayName ?? currentSlug);
        }
        if (document.visibilityState !== 'visible') return;
        setMessages((prev) => {
          const latestId = latest?.id;
          const known = prev[prev.length - 1]?.id;
          return latestId === known && prev.length === result.messages.length ? prev : result.messages;
        });
        setNextBefore(result.nextBefore);
        void markChatChannelRead(activeOrgId, currentSlug);
        void loadChannels();
        if (threadId) {
          const thread = await fetchChatMessages(activeOrgId, currentSlug, {
            parentMessageId: threadId,
            limit: 80,
          });
          setThreadMessages(thread.messages);
        }
      } catch {
        // A failed poll is not worth an error banner.
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, activeOrgId, currentSlug, threadId, loadChannels, myMemberId, people, current?.displayName]);

  useEffect(() => {
    if (!activeOrgId || !currentSlug) return;
    const key = `${DRAFT_PREFIX}${activeOrgId}:${currentSlug}`;
    const stored = window.localStorage.getItem(key);
    if (stored) setDraft(stored);
  }, [activeOrgId, currentSlug]);

  useEffect(() => {
    if (!activeOrgId || !currentSlug) return;
    const key = `${DRAFT_PREFIX}${activeOrgId}:${currentSlug}`;
    if (draft.trim()) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  }, [activeOrgId, currentSlug, draft]);

  useEffect(() => {
    if (!active || !activeOrgId) return;
    void fetchChatStatuses(activeOrgId)
      .then((result) => setStatuses(result.statuses ?? []))
      .catch(() => setStatuses([]));
  }, [active, activeOrgId, people.length]);

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
        setMentionOpen(false);
        setJumpOpen(false);
        setDetailsOpen(false);
        setStatusOpen(false);
        setShortcutsOpen(false);
        setRemindMenu(null);
        setScheduleOpen(false);
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

  function renderChannelButton(channel: ChatChannel) {
    const selected = pane === 'channel' && current?.id === channel.id;
    const draftKey = activeOrgId ? `${DRAFT_PREFIX}${activeOrgId}:${channel.slug}` : '';
    const hasDraft = Boolean(draftKey && typeof window !== 'undefined' && window.localStorage.getItem(draftKey));
    return (
      <button
        key={channel.id}
        type="button"
        className={`${styles.channelButton}${selected ? ` ${styles.channelActive}` : ''}${channel.unreadCount > 0 ? ` ${styles.channelUnread}` : ''}${channel.muted ? ` ${styles.channelMuted}` : ''}`}
        onClick={() => selectChannel(channel.slug)}
        data-testid={`team-channel-${channel.slug}`}
      >
        <Icon name={isDirect(channel) ? 'message-circle' : channel.visibility === 'private' ? 'lock' : 'hash'} size={12} />
        <span className={styles.channelName}>{channel.displayName}</span>
        {hasDraft && channel.unreadCount === 0 ? <span className={styles.draftMark}>{t('team.draft')}</span> : null}
        {channel.starred ? <Icon name="star" size={10} /> : null}
        {channel.unreadCount > 0 ? (
          <Badge tone="accent" data-testid={`team-unread-${channel.slug}`}>{channel.unreadCount}</Badge>
        ) : null}
      </button>
    );
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

  function isActive(memberId: string | null | undefined): boolean {
    if (!memberId) return false;
    const row = channelMembers.find((item) => item.memberId === memberId);
    return Boolean(row && Date.now() - row.lastReadAt < 5 * 60_000);
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
      const posted = await postChatMessage(activeOrgId, currentSlug, {
        body: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      if (parentMessageId && alsoSend && posted.message) {
        await postChatMessage(activeOrgId, currentSlug, { body: text });
        setAlsoSend(false);
      }
      pinnedToBottom.current = true;
      await loadMessages(currentSlug);
      if (parentMessageId) {
        const thread = await fetchChatMessages(activeOrgId, currentSlug, {
          parentMessageId,
          limit: 80,
        });
        setThreadMessages(thread.messages);
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

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>, parentMessageId?: string) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(parentMessageId);
    }
  }

  function queueFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    if (incoming.some((file) => file.size > CHAT_FILE_MAX_BYTES)) {
      setError(t('team.fileTooLarge'));
      return;
    }
    setPendingFiles((prev) => [...prev, ...incoming].slice(0, 8));
    setError(null);
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
    queueFiles(event.dataTransfer.files);
  }

  function onComposerPaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    queueFiles(files);
  }

  function applyMark(mark: string, text: string, setText: (value: string) => void, parentMessageId?: string) {
    const node = parentMessageId ? threadComposerRef.current : mainComposerRef.current;
    if (!node) {
      setText(wrapSelection(text, text.length, text.length, mark));
      return;
    }
    const start = node.selectionStart ?? text.length;
    const end = node.selectionEnd ?? text.length;
    setText(wrapSelection(text, start, end, mark));
  }

  async function sendLater(kind: '20m' | '1h' | 'tomorrow') {
    if (!activeOrgId || !currentSlug || !draft.trim()) return;
    try {
      await postChatMessage(activeOrgId, currentSlug, {
        body: draft.trim(),
        sendAt: chatWhen(kind),
      });
      setDraft('');
      setScheduleOpen(false);
      setScheduledOk(true);
      window.setTimeout(() => setScheduledOk(false), 2000);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function composerForm(
    text: string,
    setText: (value: string) => void,
    parentMessageId: string | undefined,
    placeholder: string,
    testId?: string,
  ) {
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
        {pendingFiles.length > 0 ? (
          <ul className={styles.pending}>
            {pendingFiles.map((file, index) => (
              <li key={`${file.name}-${index}`} className={styles.pendingChip}>
                {chatFileKind(file.type, file.name) === 'image' ? (
                  <PendingThumb file={file} />
                ) : (
                  <span className={styles.pendingGlyph} aria-hidden>
                    {file.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE'}
                  </span>
                )}
                <span className={styles.pendingCopy}>
                  <strong>{file.name}</strong>
                  <em>{formatChatFileSize(file.size)}</em>
                </span>
                <button
                  type="button"
                  className={styles.pendingRemove}
                  aria-label={t('team.removeAttachment')}
                  onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {dropping ? <p className={styles.dropHint}>{t('team.dropToAttach')}</p> : null}
        <div className={styles.composerTools}>
          <button type="button" className={styles.toolBtn} onClick={() => applyMark('*', text, setText, parentMessageId)} aria-label={t('team.bold')}>
            B
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => applyMark('_', text, setText, parentMessageId)} aria-label={t('team.italic')}>
            I
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => applyMark('~', text, setText, parentMessageId)} aria-label={t('team.strike')}>
            S
          </button>
          <button type="button" className={styles.toolBtn} onClick={() => applyMark('`', text, setText, parentMessageId)} aria-label={t('team.code')}>
            {'</>'}
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            aria-label={t('team.emoji')}
            onClick={() => setEmojiOpen((prev) => !prev)}
          >
            😊
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            aria-label={t('team.mention')}
            onClick={() => setMentionOpen((prev) => !prev)}
          >
            @
          </button>
          {!parentMessageId ? (
            <button
              type="button"
              className={styles.toolBtn}
              aria-label={t('team.schedule')}
              onClick={() => setScheduleOpen((prev) => !prev)}
            >
              {t('team.schedule')}
            </button>
          ) : null}
        </div>
        {scheduleOpen && !parentMessageId ? (
          <div className={styles.menuPop}>
            <button type="button" className={styles.mentionBtn} onClick={() => void sendLater('20m')}>{t('team.schedule20m')}</button>
            <button type="button" className={styles.mentionBtn} onClick={() => void sendLater('1h')}>{t('team.schedule1h')}</button>
            <button type="button" className={styles.mentionBtn} onClick={() => void sendLater('tomorrow')}>{t('team.scheduleTomorrow')}</button>
          </div>
        ) : null}
        {text.startsWith('/') && !parentMessageId ? <p className={styles.slashHint}>{t('team.slashHint')}</p> : null}
        {emojiOpen ? (
          <div className={styles.emojiPicker} data-testid="team-emoji-picker">
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
                        setText(`${text}${emoji}`);
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
        {mentionOpen ? (
          <ul className={styles.mentionList}>
            {['@channel', '@here', '@everyone', ...others.map((person) => `@${person.username || person.displayName}`)].map((item) => (
              <li key={item}>
                <button
                  type="button"
                  className={styles.mentionBtn}
                  onClick={() => {
                    setText(`${text}${text.endsWith(' ') || !text ? '' : ' '}${item} `);
                    setMentionOpen(false);
                  }}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={styles.composerBox}>
          <button
            type="button"
            className={styles.attachBtn}
            aria-label={t('team.attachFile')}
            data-testid={testId ? 'team-attach' : undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="attach" size={16} />
          </button>
          <Textarea
            ref={parentMessageId ? threadComposerRef : mainComposerRef}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              const value = event.target.value;
              setMentionOpen(value.endsWith('@') || /(?:^|\s)@[\w.-]*$/.test(value));
            }}
            onKeyDown={(event) => onComposerKey(event, parentMessageId)}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={sending}
            rows={2}
            data-testid={testId}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={sending || (!text.trim() && pendingFiles.length === 0)}
            data-testid={testId ? 'team-send' : undefined}
          >
            {sending ? t('team.sending') : t('team.send')}
          </Button>
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

  async function shareTo(message: TeamChatMessage, slug: string) {
    if (!activeOrgId) return;
    try {
      await postChatMessage(activeOrgId, slug, {
        body: `> ${message.body}\n_${t('team.forwardedFrom')} ${current?.displayName ?? ''}_`,
      });
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
              onOpenApp={openAppAttachment}
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
  const others = people.filter((person) => person.id !== myMemberId);
  const profilePerson = people.find((person) => person.id === profileId);

  return (
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
        <button type="button" className={`${styles.channelButton}${pane === 'reminders' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('reminders')} data-testid="team-reminders">
          <Icon name="bell" size={12} />
          <span className={styles.channelName}>{t('team.reminders')}</span>
        </button>
        <button type="button" className={`${styles.channelButton}${pane === 'scheduled' ? ` ${styles.channelActive}` : ''}`} onClick={() => setPane('scheduled')}>
          <Icon name="history" size={12} />
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
        <button type="button" className={styles.channelButton} onClick={() => {
          if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
            void Notification.requestPermission();
          }
        }}>
          <Icon name="bell" size={12} />
          <span className={styles.channelName}>{t('team.enableNotifications')}</span>
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
        {hideChannels ? null : rooms.map((channel) => renderChannelButton(channel))}

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
        {hideDms ? null : dms.map((channel) => renderChannelButton(channel))}
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
        {scheduledOk ? <p className={styles.copied}>{t('team.scheduledOk')}</p> : null}
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
                  {channelFiles.map((file) => (
                    <li key={file.id}><a href={file.url} target="_blank" rel="noreferrer">{file.label}</a></li>
                  ))}
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
          {composerForm(threadDraft, setThreadDraft, threadId, t('team.replyInThread'))}
        </aside>
      ) : null}
    </div>
  );
}
