// Loads a teammate's photo through authenticated fetch. `<img src>` would
// skip the session header, so we pull a blob and show initials if it fails.

import { useEffect, useState } from 'react';
import styles from './PersonAvatar.module.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[1]!.slice(0, 1)}`.toUpperCase();
}

export function PersonAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!avatarUrl) {
      setSrc(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetch(avatarUrl)
      .then(async (resp) => {
        if (!resp.ok) return;
        const blob = await resp.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarUrl]);

  return (
    <span className={`${styles.root}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {src ? <img className={styles.image} src={src} alt="" /> : initials(name)}
    </span>
  );
}
