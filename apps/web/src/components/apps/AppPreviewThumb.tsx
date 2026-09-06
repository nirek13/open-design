// Scaled, non-interactive thumbnail of a published app's HTML.
//
// The gallery must not navigate an iframe at `/api/projects/.../raw/...`:
// that request cannot send Authorization, and a sandboxed frame with an
// opaque origin also drops the session cookie. Fetch from the parent
// (Bearer + cookie) and paint via srcDoc, matching DesignKitView.

import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@open-design/components';
import { useT } from '../../i18n';
import { fetchProjectFileText } from '../../providers/registry';
import { DECK_MOTION_FREEZE_CSS } from '../../runtime/srcdoc';
import styles from './AppPreviewThumb.module.css';

const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 800;

const PREVIEW_CSP =
  "default-src 'none'; " +
  'img-src data: blob: https: http:; ' +
  'media-src data: blob: https: http:; ' +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  'font-src data: https: http:; ' +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'";

function previewSrcDoc(html: string): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    `<style data-od-motion-freeze>${DECK_MOTION_FREEZE_CSS}</style>`,
    html,
  ].join('\n');
}

function letterFor(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toLocaleUpperCase() : 'A';
}

export function AppPreviewThumb({
  projectId,
  filePath,
  name,
}: {
  projectId: string;
  filePath: string;
  name: string;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [scale, setScale] = useState(0.2);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setScale(Math.max(el.clientWidth, 1) / PREVIEW_WIDTH);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setFailed(false);
    setSrcDoc(null);
    void fetchProjectFileText(projectId, filePath)
      .then((html) => {
        if (cancelled) return;
        if (!html?.trim()) {
          setFailed(true);
          return;
        }
        setSrcDoc(previewSrcDoc(html));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, projectId, filePath]);

  return (
    <div ref={hostRef} className={styles.stage} data-testid="org-app-preview">
      {srcDoc ? (
        <iframe
          className={styles.frame}
          title={t('apps.previewOf', { name })}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          tabIndex={-1}
          aria-hidden="true"
          style={{
            width: PREVIEW_WIDTH,
            height: PREVIEW_HEIGHT,
            transform: `scale(${scale})`,
          }}
        />
      ) : failed ? (
        <div className={styles.fallback} aria-hidden>
          <span className={styles.letter}>{letterFor(name)}</span>
        </div>
      ) : (
        <Skeleton className={styles.skeleton} shape="block" />
      )}
    </div>
  );
}
