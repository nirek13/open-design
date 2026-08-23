// Live Gmail client. The mailbox stays in Gmail; this view talks to
// `/api/orgs/:orgId/mail/*`, which proxies Composio. Connect uses the same
// Integrations path as Calendar (`connectConnector('gmail')`).

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, EmptyState, Input, Skeleton, Textarea } from '@open-design/components';
import type { MailLabel, MailMessage, MailProfile } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  connectConnector,
  fetchConnectorStatuses,
  fetchOrgMailMessages,
  fetchOrgMailStatus,
  fetchOrgMailThread,
  modifyOrgMail,
  replyOrgMail,
  sendOrgMail,
  trashOrgMail,
} from '../../providers/registry';
import { navigate } from '../../router';
import { Icon } from '../Icon';
import styles from './MailView.module.css';

const GMAIL_CONNECTOR_ID = 'gmail';
const AUTH_POLL_MS = 2500;
const AUTH_POLL_MAX_MS = 3 * 60 * 1000;
const SYSTEM_FOLDERS = [
  { id: 'INBOX', key: 'mail.inbox' as const },
  { id: 'STARRED', key: 'mail.starred' as const },
  { id: 'SENT', key: 'mail.sent' as const },
  { id: 'DRAFT', key: 'mail.drafts' as const },
  { id: 'IMPORTANT', key: 'mail.important' as const },
  { id: 'TRASH', key: 'mail.trash' as const },
] as const;

interface Props {
  active: boolean;
  initialThreadId?: string;
}

interface ComposeDraft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  showCc: boolean;
}

function emptyDraft(): ComposeDraft {
  return { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false };
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type StatusMap = Awaited<ReturnType<typeof fetchConnectorStatuses>>;

function isGmailConnected(statuses: StatusMap | null | undefined): boolean {
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
  const entry = (statuses as Record<string, { status?: string }>)[GMAIL_CONNECTOR_ID];
  return entry?.status === 'connected';
}

async function waitForGmailConnected(signal: AbortSignal): Promise<boolean> {
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < AUTH_POLL_MAX_MS) {
    const statuses = await fetchConnectorStatuses();
    if (isGmailConnected(statuses)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, AUTH_POLL_MS));
  }
  return false;
}

function splitAddresses(value: string): string[] {
  return value.split(/[,;]/).map((part) => part.trim()).filter((part) => part.includes('@'));
}

function displayName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match?.[1]) return match[1].trim();
  return from.split('@')[0] || from;
}

function formatWhen(message: MailMessage): string {
  const instant = message.internalDate ?? (message.date ? Date.parse(message.date) : NaN);
  if (!Number.isFinite(instant)) return '';
  const date = new Date(instant);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function folderUnread(labels: MailLabel[], id: string): number | null {
  return labels.find((label) => label.id === id)?.messagesUnread ?? null;
}

const MAIL_FRAME_CSS = [
  'html,body{margin:0;padding:0;height:auto!important;background:#fff;}',
  'img,video{max-width:100%;height:auto;}',
].join('');

function wrapMailHtml(html: string): string {
  return `<style data-od-mail-fit="true">${MAIL_FRAME_CSS}</style>${html}`;
}

function MailHtmlFrame({ html, title }: { html: string; title: string }) {
  return (
    <div className={styles.bodyViewport}>
      <iframe
        className={styles.bodyFrame}
        sandbox=""
        referrerPolicy="no-referrer"
        title={title}
        srcDoc={wrapMailHtml(html)}
        data-testid="mail-body-frame"
      />
    </div>
  );
}

export function MailView({ active, initialThreadId }: Props) {
  const t = useT();
  const { activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [connected, setConnected] = useState(false);
  const [statusReady, setStatusReady] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [profile, setProfile] = useState<MailProfile | null>(null);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [folder, setFolder] = useState('INBOX');
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreadId ?? null);
  const [thread, setThread] = useState<MailMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandCursor, setCommandCursor] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const authAbortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const commandRef = useRef<HTMLInputElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  const userLabels = useMemo(
    () => labels.filter((label) => label.type === 'user').sort((a, b) => a.name.localeCompare(b.name)),
    [labels],
  );

  const reloadList = useCallback(async (pageToken?: string) => {
    if (!activeOrgId) return;
    if (pageToken) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const listed = await fetchOrgMailMessages(activeOrgId, {
        label: query ? undefined : folder,
        query: query || undefined,
        pageToken,
      });
      setConnected(listed.connected);
      setProfile(listed.profile);
      setNextPageToken(listed.nextPageToken);
      setMessages((prev) => (pageToken ? [...prev, ...listed.messages] : listed.messages));
      if (!pageToken) setSelectedIndex(0);
    } catch (err) {
      setError(asError(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [activeOrgId, folder, query]);

  const reloadStatus = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [status, statuses] = await Promise.all([
        fetchOrgMailStatus(activeOrgId),
        fetchConnectorStatuses().catch(() => null),
      ]);
      setConnected(Boolean(status.connected || isGmailConnected(statuses)));
      setProfile(status.profile);
      setLabels(status.labels);
    } catch (err) {
      setError(asError(err));
    } finally {
      setStatusReady(true);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void reloadStatus();
  }, [active, reloadStatus]);

  useEffect(() => {
    if (!active || !connected) return;
    void reloadList();
  }, [active, connected, reloadList]);

  useEffect(() => {
    if (initialThreadId) setSelectedThreadId(initialThreadId);
  }, [initialThreadId]);

  useEffect(() => {
    if (!active || !activeOrgId || !selectedThreadId || !connected) {
      setThread([]);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    void fetchOrgMailThread(activeOrgId, selectedThreadId)
      .then((result) => {
        if (cancelled) return;
        setThread(result.thread.messages);
        setMessages((prev) => prev.map((message) => (
          message.threadId === selectedThreadId
            ? { ...message, unread: false, labelIds: message.labelIds.filter((id) => id !== 'UNREAD') }
            : message
        )));
      })
      .catch((err) => {
        if (!cancelled) setError(asError(err));
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeOrgId, selectedThreadId, connected]);

  useEffect(() => () => {
    authAbortRef.current?.abort();
  }, []);

  async function onConnectGmail() {
    if (!activeOrgId || connecting || authPending) return;
    setConnecting(true);
    setError(null);
    try {
      const result = await connectConnector(GMAIL_CONNECTOR_ID);
      if (result.error) {
        if (/composio|not configured|api key/i.test(result.error)) {
          setError(t('mail.composioRequired'));
        } else {
          setError(result.error);
        }
        return;
      }
      if (result.connector?.status === 'connected') {
        setConnected(true);
        setAuthPending(false);
        await reloadStatus();
        return;
      }
      setAuthPending(true);
      authAbortRef.current?.abort();
      const controller = new AbortController();
      authAbortRef.current = controller;
      const ok = await waitForGmailConnected(controller.signal);
      if (controller.signal.aborted) return;
      if (ok) {
        setConnected(true);
        setAuthPending(false);
        await reloadStatus();
      } else {
        setAuthPending(false);
        setError(t('mail.connectTimeout'));
      }
    } catch (err) {
      setError(asError(err));
      setAuthPending(false);
    } finally {
      setConnecting(false);
    }
  }

  async function onSend() {
    if (!activeOrgId || !compose) return;
    const to = splitAddresses(compose.to);
    if (to.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendOrgMail(activeOrgId, {
        to,
        cc: splitAddresses(compose.cc),
        bcc: splitAddresses(compose.bcc),
        subject: compose.subject,
        body: compose.body,
      });
      setCompose(null);
      await reloadList();
    } catch (err) {
      setError(asError(err));
    } finally {
      setSending(false);
    }
  }

  async function onReply() {
    if (!activeOrgId || !selectedThreadId || !replyBody.trim() || sending) return;
    const latest = thread[thread.length - 1];
    const to = splitAddresses(latest?.from ?? '');
    if (to.length === 0) {
      setError(t('mail.needRecipient'));
      return;
    }
    setSending(true);
    setError(null);
    try {
      await replyOrgMail(activeOrgId, selectedThreadId, { to, body: replyBody });
      setReplyBody('');
      const result = await fetchOrgMailThread(activeOrgId, selectedThreadId);
      setThread(result.thread.messages);
    } catch (err) {
      setError(asError(err));
    } finally {
      setSending(false);
    }
  }

  async function onModify(messageId: string, addLabelIds?: string[], removeLabelIds?: string[]) {
    if (!activeOrgId) return;
    try {
      await modifyOrgMail(activeOrgId, messageId, { addLabelIds, removeLabelIds });
      await reloadList();
      if (selectedThreadId) {
        const result = await fetchOrgMailThread(activeOrgId, selectedThreadId);
        setThread(result.thread.messages);
      }
    } catch (err) {
      setError(asError(err));
    }
  }

  async function onTrash(messageId: string) {
    if (!activeOrgId) return;
    try {
      await trashOrgMail(activeOrgId, messageId);
      if (selectedThreadId && thread.some((message) => message.id === messageId)) {
        setSelectedThreadId(null);
        setThread([]);
        navigate({ kind: 'home', view: 'mail' });
      }
      await reloadList();
    } catch (err) {
      setError(asError(err));
    }
  }

  function openThread(threadId: string) {
    setSelectedThreadId(threadId);
    setReplyBody('');
    navigate({ kind: 'home', view: 'mail', threadId });
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setQuery(searchInput.trim());
    setSelectedThreadId(null);
  }

  const selectedMessage = messages[selectedIndex] ?? null;

  function runCommand(id: string) {
    setCommandOpen(false);
    setCommandQuery('');
    setCommandCursor(0);
    if (id === 'compose') {
      setCompose(emptyDraft());
      return;
    }
    if (id === 'search') {
      searchRef.current?.focus();
      return;
    }
    if (id === 'shortcuts') {
      setShortcutsOpen(true);
      return;
    }
    const target = selectedMessage ?? (selectedThreadId ? messages.find((m) => m.threadId === selectedThreadId) : null);
    if (id === 'open' && selectedMessage) {
      openThread(selectedMessage.threadId);
      return;
    }
    if (!target) return;
    if (id === 'archive') void onModify(target.id, undefined, ['INBOX']);
    if (id === 'star') {
      void onModify(
        target.id,
        target.starred ? undefined : ['STARRED'],
        target.starred ? ['STARRED'] : undefined,
      );
    }
    if (id === 'trash') void onTrash(target.id);
    if (id === 'unread') void onModify(target.id, ['UNREAD']);
    if (id === 'reply') {
      if (target.threadId !== selectedThreadId) openThread(target.threadId);
      window.setTimeout(() => replyRef.current?.focus(), 0);
    }
  }

  const commands = useMemo(() => {
    const items = [
      { id: 'compose', label: t('mail.compose'), hint: 'C' },
      { id: 'archive', label: t('mail.done'), hint: 'E' },
      { id: 'star', label: t('mail.star'), hint: 'S' },
      { id: 'reply', label: t('mail.reply'), hint: 'R' },
      { id: 'unread', label: t('mail.markUnread'), hint: 'U' },
      { id: 'trash', label: t('mail.moveTrash'), hint: '#' },
      { id: 'search', label: t('mail.search'), hint: '/' },
      { id: 'shortcuts', label: t('mail.shortcuts'), hint: '?' },
    ];
    const q = commandQuery.trim().toLowerCase();
    return q ? items.filter((item) => item.label.toLowerCase().includes(q)) : items;
  }, [commandQuery, t]);

  useEffect(() => {
    if (!active || !connected) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target && (
          target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT'
          || target.isContentEditable
        ),
      );
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (commandOpen) {
          setCommandOpen(false);
          return;
        }
        setCommandOpen(true);
        setCommandQuery('');
        setCommandCursor(0);
        window.setTimeout(() => commandRef.current?.focus(), 0);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (compose) {
          event.preventDefault();
          void onSend();
        } else if (replyBody.trim()) {
          event.preventDefault();
          void onReply();
        }
        return;
      }
      if (event.key === 'Escape') {
        if (commandOpen) {
          setCommandOpen(false);
          return;
        }
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (compose) {
          setCompose(null);
          return;
        }
        return;
      }
      if (commandOpen) {
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = commands[commandCursor] ?? commands[0];
          if (item) runCommand(item.id);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setCommandCursor((index) => Math.min(commands.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setCommandCursor((index) => Math.max(0, index - 1));
        }
        return;
      }
      if (typing || compose) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(Math.max(messages.length - 1, 0), index + 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        runCommand('open');
      } else if (event.key === 'c') {
        event.preventDefault();
        runCommand('compose');
      } else if (event.key === 'e') {
        event.preventDefault();
        runCommand('archive');
      } else if (event.key === 's') {
        event.preventDefault();
        runCommand('star');
      } else if (event.key === 'r') {
        event.preventDefault();
        runCommand('reply');
      } else if (event.key === 'u') {
        event.preventDefault();
        runCommand('unread');
      } else if (event.key === '#') {
        event.preventDefault();
        runCommand('trash');
      } else if (event.key === '/') {
        event.preventDefault();
        runCommand('search');
      } else if (event.key === '?') {
        event.preventDefault();
        runCommand('shortcuts');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (messages.length === 0) return;
    if (selectedIndex > messages.length - 1) setSelectedIndex(messages.length - 1);
  }, [messages.length, selectedIndex]);

  useEffect(() => {
    const node = document.querySelector(`[data-mail-index="${selectedIndex}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!activeOrgId) {
    return (
      <div className={styles.root} data-testid="mail-view">
        <EmptyState title={t('mail.needOrg')} description={t('mail.needOrgBody')} />
      </div>
    );
  }

  const statusClass = connected
    ? styles.statusConnected
    : authPending
      ? styles.statusPending
      : styles.statusIdle;
  const statusLabel = connected
    ? (profile?.emailAddress ?? t('mail.statusConnected'))
    : authPending
      ? t('mail.statusPending')
      : t('mail.statusDisconnected');
  const showComposioCta = Boolean(error && /composio|api key|Integrations/i.test(error));
  const latest = thread[thread.length - 1];

  return (
    <div className={styles.root} data-testid="mail-view">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t('mail.title')}</h1>
            <span className={`${styles.statusPill} ${statusClass}`}>{statusLabel}</span>
          </div>
          <p className={styles.subtitle}>{t('mail.subtitle')}</p>
        </div>
        <div className={styles.headerActions}>
          <form className={styles.search} onSubmit={onSearch}>
            <Icon name="search" size={14} />
            <Input
              ref={searchRef}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('mail.searchPlaceholder')}
              aria-label={t('mail.search')}
            />
          </form>
          {connected ? (
            <>
              <Button variant="ghost" onClick={() => void reloadList()} disabled={loading}>
                {t('mail.refresh')}
              </Button>
              <Button onClick={() => setCompose(emptyDraft())} data-testid="mail-compose">
                {t('mail.compose')}
              </Button>
            </>
          ) : (
            <Button
              disabled={connecting || authPending}
              onClick={() => void onConnectGmail()}
              data-testid="mail-connect"
            >
              {connecting || authPending ? t('mail.connecting') : t('mail.connectGmail')}
            </Button>
          )}
        </div>
      </header>

      {error ? (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          {showComposioCta ? (
            <Button variant="ghost" onClick={() => navigate({ kind: 'home', view: 'integrations' })}>
              {t('mail.openIntegrations')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!statusReady ? (
        <Skeleton className={styles.threadSkeleton} />
      ) : !connected ? (
        <EmptyState
          title={t('mail.statusDisconnected')}
          description={t('mail.disconnectedBody')}
          action={(
            <Button disabled={connecting || authPending} onClick={() => void onConnectGmail()}>
              {connecting || authPending ? t('mail.connecting') : t('mail.connectGmail')}
            </Button>
          )}
        />
      ) : (
        <div className={styles.layout}>
          <nav className={styles.folders} aria-label={t('mail.title')}>
            {SYSTEM_FOLDERS.map((item) => {
              const unread = folderUnread(labels, item.id);
              const activeFolder = folder === item.id && !query;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.folder}${activeFolder ? ` ${styles.folderActive}` : ''}`}
                  onClick={() => {
                    setFolder(item.id);
                    setQuery('');
                    setSearchInput('');
                    setSelectedThreadId(null);
                  }}
                >
                  <span>{t(item.key)}</span>
                  {unread ? <span className={styles.unreadCount}>{unread}</span> : null}
                </button>
              );
            })}
            {userLabels.length > 0 ? (
              <p className={styles.folderHeading}>{t('mail.labels')}</p>
            ) : null}
            {userLabels.map((label) => (
              <button
                key={label.id}
                type="button"
                className={`${styles.folder}${folder === label.id && !query ? ` ${styles.folderActive}` : ''}`}
                onClick={() => {
                  setFolder(label.id);
                  setQuery('');
                  setSearchInput('');
                  setSelectedThreadId(null);
                }}
              >
                <span>{label.name}</span>
                {label.messagesUnread ? <span className={styles.unreadCount}>{label.messagesUnread}</span> : null}
              </button>
            ))}
          </nav>

          <section className={styles.list} aria-label={t('mail.inbox')}>
            {loading && messages.length === 0 ? (
              Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className={styles.rowSkeleton} />)
            ) : messages.length === 0 ? (
              <p className={styles.emptyList}>{query ? t('mail.emptySearch') : t('mail.empty')}</p>
            ) : (
              messages.map((message, index) => {
                const selected = message.threadId === selectedThreadId;
                const focused = index === selectedIndex;
                return (
                  <button
                    key={message.id}
                    type="button"
                    className={[
                      styles.row,
                      message.unread ? styles.rowUnread : '',
                      selected ? styles.rowSelected : '',
                      focused ? styles.rowFocused : '',
                    ].filter(Boolean).join(' ')}
                    data-mail-index={index}
                    onClick={() => {
                      setSelectedIndex(index);
                      openThread(message.threadId);
                    }}
                  >
                    <span className={styles.pip} aria-hidden="true" />
                    <span className={styles.rowFrom}>{displayName(message.from)}</span>
                    <span className={styles.rowSubject}>
                      {message.starred ? '★ ' : ''}
                      {message.subject}
                      {message.snippet ? <span className={styles.rowSnippet}> — {message.snippet}</span> : null}
                    </span>
                    <span className={styles.rowWhen}>{formatWhen(message)}</span>
                  </button>
                );
              })
            )}
            {nextPageToken ? (
              <Button variant="ghost" disabled={loadingMore} onClick={() => void reloadList(nextPageToken)}>
                {t('mail.loadMore')}
              </Button>
            ) : null}
          </section>

          <section className={styles.read} aria-label={t('mail.thread')}>
            {!selectedThreadId ? (
              <EmptyState
                size="compact"
                title={t('mail.noSelection')}
                description={t('mail.noSelectionBody')}
              />
            ) : threadLoading && thread.length === 0 ? (
              <Skeleton className={styles.threadSkeleton} />
            ) : (
              <>
                <div className={styles.readHead}>
                  <h2 className={styles.threadSubject}>{latest?.subject ?? t('mail.thread')}</h2>
                  {latest ? (
                    <div className={styles.threadActions}>
                      <Button
                        variant="ghost"
                        onClick={() => void onModify(
                          latest.id,
                          latest.starred ? undefined : ['STARRED'],
                          latest.starred ? ['STARRED'] : undefined,
                        )}
                      >
                        {latest.starred ? t('mail.unstar') : t('mail.star')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void onModify(latest.id, undefined, ['INBOX'])}
                      >
                        {t('mail.done')}
                      </Button>
                      <Button variant="ghost" onClick={() => void onTrash(latest.id)}>
                        {t('mail.moveTrash')}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className={styles.messages}>
                  {thread.map((message) => (
                    <article key={message.id} className={styles.message}>
                      <header className={styles.messageHead}>
                        <div>
                          <p className={styles.messageFrom}>{message.from}</p>
                          <p className={styles.messageMeta}>
                            {t('mail.to')} {message.to.join(', ') || '—'}
                            {message.date || message.internalDate
                              ? ` · ${formatWhen(message)}`
                              : ''}
                          </p>
                        </div>
                      </header>
                      {message.html ? (
                        <MailHtmlFrame html={message.html} title={message.subject} />
                      ) : (
                        <pre className={styles.bodyText}>{message.text || message.snippet}</pre>
                      )}
                    </article>
                  ))}
                </div>
                <form
                  className={styles.reply}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onReply();
                  }}
                >
                  <Textarea
                    ref={replyRef}
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    rows={3}
                    placeholder={t('mail.reply')}
                    aria-label={t('mail.reply')}
                  />
                  <div className={styles.replyActions}>
                    <span className={styles.kbdHint}>{t('mail.sendHint')}</span>
                    <Button type="submit" disabled={sending || !replyBody.trim()}>
                      {sending ? t('mail.replying') : t('mail.reply')}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </section>
        </div>
      )}

      {connected ? (
        <footer className={styles.dock} aria-label={t('mail.shortcuts')}>
          <span>{t('mail.shortcutHint')}</span>
          <button type="button" className={styles.dockBtn} onClick={() => setShortcutsOpen(true)}>
            ?
          </button>
        </footer>
      ) : null}

      {commandOpen ? (
        <div
          className={styles.paletteScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) setCommandOpen(false);
          }}
        >
          <div
            className={styles.palette}
            role="dialog"
            aria-modal="true"
            aria-label={t('mail.shortcuts')}
            data-testid="mail-command-palette"
          >
            <Input
              ref={commandRef}
              value={commandQuery}
              onChange={(event) => {
                setCommandQuery(event.target.value);
                setCommandCursor(0);
              }}
              placeholder={t('mail.commandPlaceholder')}
              aria-label={t('mail.commandPlaceholder')}
              autoFocus
            />
            <ul className={styles.paletteList}>
              {commands.map((item, index) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`${styles.paletteItem}${index === commandCursor ? ` ${styles.paletteItemActive}` : ''}`}
                    onClick={() => runCommand(item.id)}
                  >
                    <span>{item.label}</span>
                    <kbd>{item.hint}</kbd>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {shortcutsOpen ? (
        <div
          className={styles.paletteScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) setShortcutsOpen(false);
          }}
        >
          <div className={styles.shortcuts} role="dialog" aria-modal="true" aria-label={t('mail.shortcuts')}>
            <h3>{t('mail.shortcuts')}</h3>
            <dl>
              <div><dt>J / K</dt><dd>Move</dd></div>
              <div><dt>Enter</dt><dd>Open</dd></div>
              <div><dt>E</dt><dd>{t('mail.done')}</dd></div>
              <div><dt>C</dt><dd>{t('mail.compose')}</dd></div>
              <div><dt>R</dt><dd>{t('mail.reply')}</dd></div>
              <div><dt>S</dt><dd>{t('mail.star')}</dd></div>
              <div><dt>U</dt><dd>{t('mail.markUnread')}</dd></div>
              <div><dt>#</dt><dd>{t('mail.moveTrash')}</dd></div>
              <div><dt>/</dt><dd>{t('mail.search')}</dd></div>
              <div><dt>⌘K</dt><dd>{t('mail.shortcuts')}</dd></div>
              <div><dt>⌘Enter</dt><dd>{t('mail.send')}</dd></div>
              <div><dt>?</dt><dd>{t('mail.shortcuts')}</dd></div>
            </dl>
          </div>
        </div>
      ) : null}

      {compose ? (
        <div
          className={styles.modalScrim}
          onClick={(event) => {
            if (event.target === event.currentTarget) setCompose(null);
          }}
        >
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('mail.compose')}>
            <h3 className={styles.modalTitle}>{t('mail.compose')}</h3>
            <label className={styles.field}>
              <span>{t('mail.to')}</span>
              <Input
                value={compose.to}
                onChange={(event) => setCompose({ ...compose, to: event.target.value })}
                autoFocus
              />
            </label>
            {compose.showCc ? (
              <>
                <label className={styles.field}>
                  <span>{t('mail.cc')}</span>
                  <Input
                    value={compose.cc}
                    onChange={(event) => setCompose({ ...compose, cc: event.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('mail.bcc')}</span>
                  <Input
                    value={compose.bcc}
                    onChange={(event) => setCompose({ ...compose, bcc: event.target.value })}
                  />
                </label>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setCompose({ ...compose, showCc: true })}>
                {t('mail.showCc')}
              </Button>
            )}
            <label className={styles.field}>
              <span>{t('mail.subject')}</span>
              <Input
                value={compose.subject}
                onChange={(event) => setCompose({ ...compose, subject: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>{t('mail.body')}</span>
              <Textarea
                rows={8}
                value={compose.body}
                onChange={(event) => setCompose({ ...compose, body: event.target.value })}
              />
            </label>
            <div className={styles.modalActions}>
              <span className={styles.kbdHint}>{t('mail.sendHint')}</span>
              <Button variant="ghost" onClick={() => setCompose(null)}>{t('mail.cancel')}</Button>
              <Button
                disabled={sending || splitAddresses(compose.to).length === 0}
                onClick={() => void onSend()}
              >
                {sending ? t('mail.sending') : t('mail.send')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
