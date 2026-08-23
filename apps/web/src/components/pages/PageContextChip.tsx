import { useT } from '../../i18n';
import styles from './PageContextChip.module.css';

export function PageContextChip({
  title,
  icon,
  onOpen,
  compact = false,
  testId = 'page-context-chip',
}: {
  title: string;
  icon?: string | null;
  onOpen?: () => void;
  compact?: boolean;
  testId?: string;
}) {
  const t = useT();
  const label = title.trim() || t('pages.untitled');
  const inner = (
    <>
      {compact ? null : <span className={styles.kicker}>{t('pages.buildingOn')}</span>}
      <span className={styles.page} title={label}>
        <span aria-hidden>{icon?.trim() || '📄'}</span>
        <span className={styles.title}>{label}</span>
      </span>
    </>
  );
  const className = [
    styles.chip,
    compact ? styles.compact : '',
    onOpen ? styles.button : '',
  ].filter(Boolean).join(' ');
  if (onOpen) {
    return (
      <button
        type="button"
        className={className}
        data-testid={testId}
        onClick={onOpen}
        title={t('pages.openPageContext', { title: label })}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={className} data-testid={testId} title={t('pages.buildingOn')}>
      {inner}
    </div>
  );
}
