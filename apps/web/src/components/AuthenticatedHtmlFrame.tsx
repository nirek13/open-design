// Same-origin HTML that must run in an opaque iframe sandbox (no
// `allow-same-origin`) cannot send the SameSite=Lax `od_session` cookie.
// Navigating with `src=/api/projects/:id/raw/...` therefore 401s. Fetch from
// the parent (Bearer + cookie) and paint the document via srcDoc instead.
//
// Do not inject `<base href>` pointing at `/raw/` — relative subresources
// inside the opaque frame would hit those URLs without a session.

import { useEffect, useState } from 'react';
import { buildSrcdoc } from '../runtime/srcdoc';

export interface AuthenticatedHtmlFrameProps {
  src: string;
  title: string;
  sandbox: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  tabIndex?: number;
  'aria-hidden'?: boolean | 'true';
  allow?: string;
  allowFullScreen?: boolean;
}

export function AuthenticatedHtmlFrame({
  src,
  title,
  sandbox,
  className,
  loading,
  tabIndex,
  'aria-hidden': ariaHidden,
  allow,
  allowFullScreen,
}: AuthenticatedHtmlFrameProps) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrcDoc(null);
    void fetch(src, { cache: 'no-store', credentials: 'include' })
      .then(async (resp) => {
        if (!resp.ok || cancelled) return;
        const html = await resp.text();
        if (cancelled) return;
        setSrcDoc(buildSrcdoc(html));
      })
      .catch(() => {
        // Missing or unreadable preview — leave the frame blank.
      });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return (
    <iframe
      className={className}
      title={title}
      sandbox={sandbox}
      srcDoc={srcDoc ?? undefined}
      data-preview-src={src}
      loading={loading}
      tabIndex={tabIndex}
      aria-hidden={ariaHidden}
      allow={allow}
      allowFullScreen={allowFullScreen}
    />
  );
}
