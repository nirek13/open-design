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
  type ChatChannel,
  type OrgMember,
  type TeamChatAttachment,
  type TeamChatMessage,
} from '@open-design/contracts';
import { PersonAvatar } from '../account/PersonAvatar';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import { useOptionalRunningApp } from '../apps/RunningAppContext';
import {
  createChatChannel,
  deleteChatMessage,
  editChatMessage,
  fetchChatChannelMembers,
  fetchChatChannels,
  fetchChatMessages,
  fetchDesignSystemFile,
  fetchDesignSystemFiles,
  fetchDesignSystems,
  fetchOrgApps,
  fetchOrgMembers,
  inviteChatMembers,
  joinChatChannel,
  leaveChatChannel,
  markChatChannelRead,
  openChatDirectMessage,
  postChatMessage,
  searchChatMessages,
  setUpChatChannels,
  toggleChatReaction,
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
const QUICK_REACTIONS = ['👍', '🎉', '❤️', '👀', '😄'];

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  const current = channels.find((channel) => channel.slug === currentSlug || channel.id === currentSlug) ?? null;
  const parentInThread = messages.find((message) => message.id === threadId) ?? threadMessages[0] ?? null;

  const loadChannels = useCallback(async () => {
    if (!activeOrgId) return [] as ChatChannel[];
    const result = await fetchChatChannels(activeOrgId);
    setChannels(result.channels);
    setLoaded(true);
    return result.channels;
  }, [activeOrgId]);

  const loadMessages = useCallback(async (slug: string) => {
    if (!activeOrgId) return;
    const result = await fetchChatMessages(activeOrgId, slug, { limit: 80 });
    setMessages(result.messages);
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
    if (!active || !activeOrgId || !currentSlug) return;
    void (async () => {
      try {
        await loadMessages(currentSlug);
        pinnedToBottom.current = true;
        await markChatChannelRead(activeOrgId, currentSlug);
        await loadChannels();
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [active, activeOrgId, currentSlug, loadChannels, loadMessages]);

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
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await fetchChatMessages(activeOrgId, currentSlug, { limit: 80 });
        setMessages((prev) => {
          const latest = result.messages[result.messages.length - 1]?.id;
          const known = prev[prev.length - 1]?.id;
          return latest === known && prev.length === result.messages.length ? prev : result.messages;
        });
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
  }, [active, activeOrgId, currentSlug, threadId, loadChannels]);

  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, currentSlug]);

  function selectChannel(slug: string) {
    setCurrentSlug(slug);
    setThreadId(null);
    setSearchOpen(false);
    setSearchHits(null);
    navigate({ kind: 'home', view: homeView, channelId: slug });
  }

  async function send(parentMessageId?: string) {
    if (!activeOrgId || !currentSlug) return;
    const text = (parentMessageId ? threadDraft : draft).trim();
    const files = pendingFiles;
    if (!text && files.length === 0) return;
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
      await postChatMessage(activeOrgId, currentSlug, {
        body: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
      });
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
            value={text}
            onChange={(event) => setText(event.target.value)}
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

  function renderMessage(message: TeamChatMessage, inThread = false) {
    const member = people.find((person) => person.id === message.authorMemberId);
    const mine = Boolean(myMemberId && message.authorMemberId === myMemberId);
    const labeled = message.system
      ? t('team.system')
      : labelPerson(member, message.authorName, t('team.someone'));
    const author = !message.system && mine ? t('team.me') : labeled;
    return (
      <article
        key={message.id}
        className={`${styles.message}${message.system ? ` ${styles.systemMessage}` : ''}`}
        data-testid={`team-message-${message.id}`}
      >
        <PersonAvatar name={labeled} avatarUrl={member?.avatarUrl} className={styles.avatar} />
        <div className={styles.messageBody}>
          <header className={styles.messageMeta}>
            <span className={styles.author}>{author}</span>
            <time>{formatClock(message.createdAt)}</time>
            {message.editedAt ? <span className={styles.edited}>{t('team.edited')}</span> : null}
          </header>
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
  const others = people.filter((person) => person.id !== myMemberId);

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
        <p className={styles.workspaceName} data-testid="team-workspace-name">
          {workspaceLabel(activeOrg?.name, t('team.workspace'))}
        </p>
        <form className={styles.search} onSubmit={(event) => void onSearch(event)}>
          <Icon name="search" size={14} />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('team.searchPlaceholder')}
            aria-label={t('team.search')}
          />
        </form>

        <div className={styles.sidebarHead}>
          <h2 className={styles.sectionLabel}>{t('team.channels')}</h2>
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
        {rooms.map((channel) => {
          const selected = current?.id === channel.id;
          return (
            <button
              key={channel.id}
              type="button"
              className={`${styles.channelButton}${selected ? ` ${styles.channelActive}` : ''}`}
              onClick={() => selectChannel(channel.slug)}
              data-testid={`team-channel-${channel.slug}`}
            >
              <Icon name={channel.visibility === 'private' ? 'lock' : 'hash'} size={12} />
              <span className={styles.channelName}>{channel.displayName}</span>
              {channel.unreadCount > 0 ? (
                <Badge tone="accent" data-testid={`team-unread-${channel.slug}`}>{channel.unreadCount}</Badge>
              ) : null}
            </button>
          );
        })}

        <div className={styles.sidebarHead}>
          <h2 className={styles.sectionLabel}>{t('team.directMessages')}</h2>
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
        {dms.map((channel) => {
          const selected = current?.id === channel.id;
          return (
            <button
              key={channel.id}
              type="button"
              className={`${styles.channelButton}${selected ? ` ${styles.channelActive}` : ''}`}
              onClick={() => selectChannel(channel.slug)}
              data-testid={`team-channel-${channel.slug}`}
            >
              <Icon name="message-circle" size={12} />
              <span className={styles.channelName}>{channel.displayName}</span>
              {channel.unreadCount > 0 ? (
                <Badge tone="accent" data-testid={`team-unread-${channel.slug}`}>{channel.unreadCount}</Badge>
              ) : null}
            </button>
          );
        })}
      </nav>

      <section className={styles.main} aria-label={current ? current.displayName : t('team.title')}>
        {!current && !searchOpen ? (
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
              {current && !current.joined ? (
                <Button onClick={() => void join()} disabled={busy} data-testid="team-join">
                  {t('team.join')}
                </Button>
              ) : null}
              {current?.joined && current.kind === 'channel' ? (
                <Button variant="ghost" onClick={() => void leave()} disabled={busy}>
                  {t('team.leave')}
                </Button>
              ) : null}
            </header>
            <div
              className={styles.transcript}
              ref={transcriptRef}
              onScroll={(event) => {
                const node = event.currentTarget;
                pinnedToBottom.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 48;
              }}
              data-testid="team-transcript"
            >
              {visibleMessages.length === 0 ? (
                <p className={styles.emptyTranscript}>
                  {searchOpen ? t('team.emptySearch') : t('team.noMessages')}
                </p>
              ) : (
                visibleMessages.map((message) => renderMessage(message))
              )}
            </div>
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
