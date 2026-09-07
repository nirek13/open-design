// Compact search field in the tab chrome, next to the organization badge.
// It does not search in-place: a click opens the same spotlight palette as
// Cmd+1 / Ctrl+1 (and Cmd+Space / Ctrl+Space).

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { requestToggleSearch, searchShortcutLabel } from './search-hotkey';
import styles from './ChromeSearchTrigger.module.css';

interface Props {
  open?: boolean;
}

export function ChromeSearchTrigger({ open = false }: Props) {
  const t = useT();
  const shortcut = searchShortcutLabel();
  return (
    <button
      type="button"
      className={styles.trigger}
      onClick={requestToggleSearch}
      aria-label={`${t('search.title')} (${shortcut})`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`${t('search.title')} (${shortcut})`}
      data-testid="chrome-search-trigger"
    >
      <Icon name="search" size={14} />
      <span className={styles.label}>{t('search.title')}</span>
      <kbd className={styles.shortcut}>{shortcut}</kbd>
    </button>
  );
}
