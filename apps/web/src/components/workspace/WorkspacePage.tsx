// The frame every workspace surface sits in.
//
// One component owns the page header, the content column, and the section
// rhythm, so the workspace, the books, and the approvals inbox cannot drift
// apart visually. Surfaces supply a title, an optional lead sentence, actions,
// and tabs; everything else about the shape of a page is decided here.

import type { ReactNode } from 'react';
import styles from './WorkspacePage.module.css';

export interface WorkspaceTab {
  id: string;
  label: string;
  /** Shown as a small count chip after the label. Omit for no chip. */
  count?: number | null;
}

interface Props {
  title: string;
  lead?: string;
  /** Small text above the title — usually the organization name. */
  eyebrow?: string;
  actions?: ReactNode;
  tabs?: WorkspaceTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** Full-bleed row directly under the header. */
  banner?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Fill the parent pane and skip the reading-column max-width. */
  fill?: boolean;
  /** Studio wash for the company hub. Other workspace pages stay flat paper. */
  studio?: boolean;
  /** First-prompt launch: chrome recedes while the composer morphs into the studio. */
  launching?: boolean;
}

export function WorkspacePage({
  title,
  lead,
  eyebrow,
  actions,
  tabs,
  activeTab,
  onTabChange,
  banner,
  children,
  testId,
  fill = false,
  studio = false,
  launching = false,
}: Props) {
  return (
    <div
      className={`${styles.root}${fill ? ` ${styles.rootFill}` : ''}${studio ? ` ${styles.studio}` : ''}${launching ? ` ${styles.launching}` : ''}`}
      data-testid={testId}
      {...(launching ? { 'data-launching': 'true' } : {})}
    >
      <div className={`${styles.column}${fill ? ` ${styles.columnFill}` : ''}`}>
        <header className={styles.head}>
          <div className={styles.headText}>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h1 className={styles.title}>{title}</h1>
            {lead ? <p className={styles.lead}>{lead}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>

        {banner ? <div className={styles.banner}>{banner}</div> : null}

        {tabs && tabs.length > 0 ? (
          <nav className={styles.tabs} aria-label={title}>
            {tabs.map((tab) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`${styles.tab}${active ? ` ${styles.tabActive}` : ''}`}
                  onClick={() => onTabChange?.(tab.id)}
                  data-testid={`workspace-tab-${tab.id}`}
                >
                  {tab.label}
                  {typeof tab.count === 'number' ? (
                    <span className={styles.tabCount}>{tab.count}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        ) : null}

        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}

/** A titled block within a page. `action` sits opposite the title. */
export function WorkspaceSection({
  title,
  action,
  children,
  className,
  testId,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`${styles.section}${className ? ` ${className}` : ''}`} data-testid={testId}>
      {title || action ? (
        <div className={styles.sectionHead}>
          {title ? <h2 className={styles.sectionTitle}>{title}</h2> : <span />}
          {action ? <div className={styles.sectionAction}>{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
