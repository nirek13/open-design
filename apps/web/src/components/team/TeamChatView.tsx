// Team chat.
//
// A channel list beside a transcript, which is the shape everyone already
// knows. Two behaviours worth naming:
//
//   - Opening a channel marks it read; posting does not. Posting from the CLI
//     or an integration is not evidence you have read what other people said,
//     so the read marker follows what was actually on screen.
//   - New messages arrive by polling while the tab is visible. Polling is the
//     honest primitive here: it degrades to "slightly late" rather than to
//     "silently disconnected", and it stops entirely when the tab is hidden.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Input, Skeleton } from '@open-design/components';
import type { ChatChannel, TeamChatMessage } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  createChatChannel,
  fetchChatChannels,
  fetchChatMessages,
  joinChatChannel,
  markChatChannelRead,
  postChatMessage,
  setUpChatChannels,
} from '../../providers/registry';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { formatDateTime } from '../workspace/format';
import styles from './TeamChatView.module.css';

interface Props {
  active: boolean;
}

/** How often to look for new messages while the tab is visible. Slow enough
 * to be cheap, fast enough that a conversation does not feel one-sided. */
const POLL_INTERVAL_MS = 5_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function TeamChatView({ active }: Props) {
  const t = useT();
  const { activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [currentSlug, setCurrentSlug] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Only stick to the bottom when the reader is already there — yanking the
  // view down while someone reads history is the classic chat annoyance.
  const pinnedToBottom = useRef(true);

  const current = useMemo(
    () => channels.find((channel) => channel.slug === currentSlug) ?? null,
    [channels, currentSlug],
  );

  const loadChannels = useCallback(async () => {
    if (!activeOrgId) return [] as ChatChannel[];
    const result = await fetchChatChannels(activeOrgId);
    setChannels(result.channels);
    setLoaded(true);
    return result.channels;
  }, [activeOrgId]);

  const loadMessages = useCallback(
    async (slug: string) => {
      if (!activeOrgId) return;
      const result = await fetchChatMessages(activeOrgId, slug, { limit: 100 });
      setMessages(result.messages);
    },
    [activeOrgId],
  );

  // First load: channels, then whichever one we land on.
  useEffect(() => {
    if (!active || !activeOrgId) return;
    void (async () => {
      try {
        const next = await loadChannels();
        setCurrentSlug((prev) => prev ?? next.find((channel) => channel.joined)?.slug ?? next[0]?.slug ?? null);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [active, activeOrgId, loadChannels]);

  // Opening a channel is what marks it read.
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

  // Poll for new messages, but only while this tab is actually on screen.
  useEffect(() => {
    if (!active || !activeOrgId || !currentSlug) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await fetchChatMessages(activeOrgId, currentSlug, { limit: 100 });
        if (cancelled) return;
        setMessages((prev) => {
          const latest = result.messages[result.messages.length - 1]?.id;
          const known = prev[prev.length - 1]?.id;
          // Replacing the array on every tick would reset scroll and selection
          // for no reason; only swap when something actually changed.
          return latest === known && prev.length === result.messages.length ? prev : result.messages;
        });
        void markChatChannelRead(activeOrgId, currentSlug);
      } catch {
        // A failed poll is not worth an error banner — the next one may work,
        // and the user has done nothing wrong.
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, activeOrgId, currentSlug]);

  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    if (!activeOrgId || !currentSlug) return;
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      // Clear the box immediately: retyping a message because the network was
      // slow is worse than a rare double-send the user can see and delete.
      setDraft('');
      await postChatMessage(activeOrgId, currentSlug, { body });
      pinnedToBottom.current = true;
      await loadMessages(currentSlug);
      await markChatChannelRead(activeOrgId, currentSlug);
      await loadChannels();
      setError(null);
    } catch (err) {
      setDraft(body);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, currentSlug, draft, loadChannels, loadMessages]);

  const create = useCallback(async () => {
    if (!activeOrgId) return;
    const name = newChannelName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const channel = await createChatChannel(activeOrgId, { displayName: name });
      setNewChannelName('');
      setCreating(false);
      await loadChannels();
      setCurrentSlug(channel.slug);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, loadChannels, newChannelName]);

  const setUp = useCallback(async () => {
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
  }, [activeOrgId, loadChannels]);

  const join = useCallback(async () => {
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
  }, [activeOrgId, currentSlug, loadChannels]);

  if (!activeOrgId) {
    return (
      <WorkspacePage title={t('team.title')} testId="team-chat-view">
        <EmptyState title={t('team.noOrg')} />
      </WorkspacePage>
    );
  }

  if (!loaded) {
    return (
      <WorkspacePage title={t('team.title')} testId="team-chat-view">
        <Skeleton />
      </WorkspacePage>
    );
  }

  if (channels.length === 0) {
    return (
      <WorkspacePage title={t('team.title')} lead={t('team.lead')} testId="team-chat-view">
        <EmptyState
          title={t('team.setUpTitle')}
          description={t('team.setUpBody')}
          action={
            <Button onClick={setUp} disabled={busy} data-testid="team-setup">
              {busy ? t('team.settingUp') : t('team.setUpAction')}
            </Button>
          }
        />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage title={t('team.title')} lead={t('team.lead')} testId="team-chat-view">
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label={t('team.channels')}>
          <div className={styles.sidebarHead}>
            <h2 className={styles.sidebarTitle}>{t('team.channels')}</h2>
            <Button
              variant="ghost"
              onClick={() => setCreating((prev) => !prev)}
              data-testid="team-new-channel"
            >
              {t('team.newChannel')}
            </Button>
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
              <Button type="submit" disabled={busy || !newChannelName.trim()}>
                {t('team.create')}
              </Button>
            </form>
          ) : null}

          <ul className={styles.channelList}>
            {channels.map((channel) => {
              const selected = channel.slug === currentSlug;
              return (
                <li key={channel.id}>
                  <button
                    type="button"
                    className={`${styles.channelButton}${selected ? ` ${styles.channelActive}` : ''}`}
                    onClick={() => setCurrentSlug(channel.slug)}
                    aria-current={selected ? 'true' : undefined}
                    data-testid={`team-channel-${channel.slug}`}
                  >
                    <span className={styles.channelName}>
                      #{channel.slug}
                      {channel.visibility === 'private' ? (
                        <span className={styles.privateMark} title={t('team.private')}>
                          {' '}
                          ●
                        </span>
                      ) : null}
                    </span>
                    {channel.unreadCount > 0 ? (
                      <Badge tone="accent" data-testid={`team-unread-${channel.slug}`}>
                        {channel.unreadCount}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className={styles.main} aria-label={current ? `#${current.slug}` : t('team.title')}>
          <header className={styles.channelHead}>
            <div>
              <h2 className={styles.channelTitle}>#{current?.slug ?? ''}</h2>
              {current?.topic ? <p className={styles.topic}>{current.topic}</p> : null}
            </div>
            {current && !current.joined ? (
              <Button onClick={join} disabled={busy} data-testid="team-join">
                {t('team.join')}
              </Button>
            ) : null}
          </header>

          <div
            className={styles.transcript}
            ref={transcriptRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              pinnedToBottom.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 40;
            }}
            data-testid="team-transcript"
          >
            {messages.length === 0 ? (
              <p className={styles.emptyTranscript}>{t('team.noMessages')}</p>
            ) : (
              <ul className={styles.messages}>
                {messages.map((message) => (
                  <li
                    key={message.id}
                    className={`${styles.message}${message.system ? ` ${styles.systemMessage}` : ''}`}
                    data-testid={`team-message-${message.id}`}
                  >
                    <div className={styles.messageMeta}>
                      <span className={styles.author}>
                        {message.system ? t('team.system') : (message.authorName ?? t('team.someone'))}
                      </span>
                      <span className={styles.timestamp}>{formatDateTime(message.createdAt)}</span>
                      {message.editedAt ? (
                        <span className={styles.edited}>{t('team.edited')}</span>
                      ) : null}
                    </div>
                    <p className={styles.body}>{message.body}</p>
                    {message.attachments.length > 0 ? (
                      <ul className={styles.attachments}>
                        {message.attachments.map((attachment, index) => (
                          <li key={`${attachment.kind}-${attachment.id}-${index}`}>
                            <Badge tone="info">{attachment.label}</Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {message.replyCount > 0 ? (
                      <p className={styles.replies}>
                        {t('team.replyCount', { count: String(message.replyCount) })}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('team.messagePlaceholder', { channel: current?.slug ?? '' })}
              aria-label={t('team.messagePlaceholder', { channel: current?.slug ?? '' })}
              disabled={busy}
              data-testid="team-composer"
            />
            <Button type="submit" disabled={busy || !draft.trim()} data-testid="team-send">
              {t('team.send')}
            </Button>
          </form>
        </section>
      </div>
    </WorkspacePage>
  );
}
