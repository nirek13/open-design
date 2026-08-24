'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  loadCreatedEmbedItems,
  type CreatedEmbedItem,
  type CreatedEmbedKind,
} from '../../runtime/created-embed';
import styles from './CreatedWorkPicker.module.css';

const FILTERS: Array<{ id: 'all' | CreatedEmbedKind; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'app', label: 'Apps' },
  { id: 'image', label: 'Pictures' },
  { id: 'video', label: 'Videos' },
  { id: 'slides', label: 'Slides' },
];

const KIND_MARK: Record<CreatedEmbedKind, string> = {
  app: 'App',
  image: 'Picture',
  video: 'Video',
  slides: 'Slides',
};

interface Props {
  orgId: string;
  query?: string;
  onPick: (url: string) => void;
}

export function CreatedWorkPicker({ orgId, query = '', onPick }: Props) {
  const [items, setItems] = useState<CreatedEmbedItem[]>([]);
  const [filter, setFilter] = useState<'all' | CreatedEmbedKind>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadCreatedEmbedItems(orgId)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.subtitle.toLowerCase().includes(needle)
      );
    });
  }, [filter, items, query]);

  if (loading && items.length === 0) {
    return <p className={styles.status}>Loading what you created…</p>;
  }
  if (items.length === 0) {
    return (
      <p className={styles.status}>
        Nothing to embed yet — create an app, picture, video, or slides, or paste a URL above.
      </p>
    );
  }

  return (
    <div className={styles.picker} data-testid="pages-created-picker">
      <div className={styles.filters} role="tablist" aria-label="Created work">
        {FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={filter === chip.id}
            className={styles.chip}
            data-active={filter === chip.id ? 'true' : 'false'}
            onClick={() => setFilter(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className={styles.status}>No matches in what you created.</p>
      ) : (
        <ul className={styles.list}>
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={styles.item}
                data-testid="pages-created-item"
                data-kind={item.kind}
                onClick={() => onPick(item.url)}
              >
                {item.thumbUrl ? (
                  <img className={styles.thumb} src={item.thumbUrl} alt="" />
                ) : (
                  <span className={styles.mark} data-kind={item.kind} aria-hidden>
                    {KIND_MARK[item.kind].slice(0, 1)}
                  </span>
                )}
                <span className={styles.copy}>
                  <strong>{item.title}</strong>
                  <em>
                    {KIND_MARK[item.kind]}
                    {item.subtitle ? ` · ${item.subtitle}` : ''}
                  </em>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
