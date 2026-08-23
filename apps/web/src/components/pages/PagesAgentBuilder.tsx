import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useI18n, useT } from '../../i18n';
import { patchProject } from '../../state/projects';
import type { AgentInfo, AppConfig, SkillSummary } from '../../types';
import { ChatPane } from '../ChatPane';
import type { SettingsSection } from '../SettingsDialog';
import { Icon } from '../Icon';
import { useConversationChat } from '../workspace/useConversationChat';
import { PageContextChip } from './PageContextChip';
import styles from './PagesAgentBuilder.module.css';

export interface PagesAgentSession {
  projectId: string;
  conversationId: string;
  pageId: string | null;
  pageTitle: string;
  pageIcon: string | null;
  seedPrompt: string;
}

interface Props {
  session: PagesAgentSession;
  layout: 'docked' | 'expanded';
  config: AppConfig;
  agents: AgentInfo[];
  skills?: SkillSummary[];
  pagesNav?: ReactNode;
  onTogglePagesNav?: () => void;
  pagesNavOpen?: boolean;
  onExpand: () => void;
  onDock: () => void;
  onClose: () => void;
  onSeeded?: () => void;
  onOpenSettings?: (section?: SettingsSection) => void;
}

export function PagesAgentBuilder({
  session,
  layout,
  config,
  agents,
  skills = [],
  pagesNav,
  onTogglePagesNav,
  pagesNavOpen = false,
  onExpand,
  onDock,
  onClose,
  onSeeded,
  onOpenSettings,
}: Props) {
  const t = useT();
  const { locale } = useI18n();
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const chat = useConversationChat(session.projectId, session.conversationId, {
    config,
    agentsById,
    locale,
    sessionMode: 'design',
  });
  const seeded = useRef(false);

  useEffect(() => {
    seeded.current = false;
  }, [session.projectId, session.conversationId]);

  useEffect(() => {
    if (seeded.current || chat.loading) return;
    const prompt = session.seedPrompt.trim();
    if (!prompt) return;
    seeded.current = true;
    chat.onSend(prompt, [], []);
    void patchProject(session.projectId, { pendingPrompt: null });
    onSeeded?.();
  }, [chat.loading, chat.onSend, onSeeded, session.projectId, session.seedPrompt]);

  const conversations = useMemo(
    () => [
      {
        id: session.conversationId,
        projectId: session.projectId,
        title: session.pageTitle || t('pages.untitled'),
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    [session.conversationId, session.pageTitle, session.projectId, t],
  );

  return (
    <div
      className={styles.builder}
      data-testid="pages-agent-builder"
      data-layout={layout}
    >
      <header className={styles.chrome}>
        {onTogglePagesNav ? (
          <button
            type="button"
            className={`${styles.iconBtn}${pagesNavOpen ? ` ${styles.iconBtnActive}` : ''}`}
            aria-label={t('pages.builderPages')}
            aria-pressed={pagesNavOpen}
            title={t('pages.builderPages')}
            onClick={onTogglePagesNav}
          >
            <Icon name="panel-left" size={16} />
          </button>
        ) : null}
        <div className={styles.chip}>
          <PageContextChip title={session.pageTitle} icon={session.pageIcon} />
        </div>
        {layout === 'docked' ? (
          <button
            type="button"
            className={styles.iconBtn}
            data-testid="pages-agent-expand"
            aria-label={t('pages.builderFullscreen')}
            title={t('pages.builderFullscreen')}
            onClick={onExpand}
          >
            <Icon name="maximize" size={16} />
          </button>
        ) : (
          <button
            type="button"
            className={styles.iconBtn}
            data-testid="pages-agent-dock"
            aria-label={t('pages.builderShowPage')}
            title={t('pages.builderShowPage')}
            onClick={onDock}
          >
            <Icon name="minimize" size={16} />
          </button>
        )}
        <button
          type="button"
          className={styles.iconBtn}
          data-testid="pages-agent-close"
          aria-label={t('pages.builderClose')}
          title={t('pages.builderClose')}
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      {pagesNav}
      <div className={styles.pane}>
        <ChatPane
          messages={chat.messages}
          streaming={chat.streaming}
          loading={chat.loading}
          error={chat.error}
          projectId={session.projectId}
          projectFiles={[]}
          onEnsureProject={async () => session.projectId}
          onSend={chat.onSend}
          onRetry={chat.onRetry}
          onStop={chat.onStop}
          skills={skills}
          conversations={conversations}
          activeConversationId={session.conversationId}
          onSelectConversation={() => undefined}
          onDeleteConversation={() => undefined}
          researchAvailable={config.mode === 'daemon'}
          config={config}
          projectMetadata={{ kind: 'other' }}
          composerPlaceholder={t('pages.askPlaceholder')}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}
