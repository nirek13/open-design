// Running an app.
//
// The app is untrusted code. It runs in an iframe sandboxed *without*
// `allow-same-origin`, so it has an opaque origin: no cookies, no access to
// this page's DOM, no shared storage. Its CSP keeps `connect-src 'none'`, so
// it has no network of its own and cannot send anything anywhere.
//
// It gets data by asking. Every `postMessage` request is checked against the
// scopes the app declared when it was published (`scopeAllows`), and the calls
// this host then makes are ordinary `/api/data/*` calls carrying the current
// member's session — so every tenancy and role check already in the daemon
// applies unchanged, and an app can never do more than the person running it.
//
// That is the whole security model, and it is deliberately boring: no new
// token to leak, no new privileged endpoint, no relaxed CSP. The failure mode
// of a bug here is "the app is refused", not "the app got the data anyway".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button } from '@open-design/components';
import {
  APP_BRIDGE_PROTOCOL,
  describeAppScopes,
  type AppBridgeRequest,
  type AppBridgeResponse,
  type OrgApp,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { publishAppToWeb } from '../../providers/registry';
import { APP_SDK_SOURCE } from './appSdk';
import { AppBridgeRefused, performAppBridgeRequest, tableForAppBridgeRequest } from './app-bridge-host';
import { SendAppPicker } from './SendAppPicker';
import styles from './AppRunner.module.css';

interface Props {
  orgId: string;
  app: OrgApp;
  /** The app's HTML, already fetched by the caller. */
  source: string;
  onClose: () => void;
  /** Open the source design for editing (workspace-focused, not chat-first). */
  onEdit?: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One line per bridge call, so a person can see what an app actually did
 * rather than trusting what it declared. */
interface CallLogEntry {
  at: number;
  kind: string;
  table: string | null;
  allowed: boolean;
  detail: string;
}

export function AppRunner({ orgId, app, source, onClose, onEdit }: Props) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [log, setLog] = useState<CallLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webUrl, setWebUrl] = useState(app.webUrl);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSend, setShowSend] = useState(false);

  useEffect(() => {
    setWebUrl(app.webUrl);
  }, [app.webUrl]);

  const scopes = app.dataScopes ?? [];

  /** The document handed to the iframe: the app's own HTML with the tiny SDK
   * prepended, plus a meta CSP so the sandbox holds even though this is a
   * srcDoc rather than a served response. */
  const srcDoc = useMemo(() => {
    // Remote https images/fonts are common in published designs (CDN assets,
    // Unsplash, Google Fonts). Keep script/connect locked down — apps still
    // have no network of their own beyond what the host bridge allows.
    const csp =
      "default-src 'none'; " +
      "img-src data: blob: https: http:; " +
      "media-src data: blob: https: http:; " +
      "style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline'; " +
      "font-src data: https: http:; " +
      "connect-src 'none'; " +
      "form-action 'none'; " +
      "base-uri 'none'";
    return [
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      `<script>${APP_SDK_SOURCE}</script>`,
      source,
    ].join('\n');
  }, [source]);

  const note = useCallback((entry: CallLogEntry) => {
    // Newest first, bounded — this is an activity log, not an audit store.
    setLog((prev) => [entry, ...prev].slice(0, 200));
  }, []);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      // The sandboxed frame has an opaque origin, so identity is established
      // by comparing the source window rather than by origin string.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;

      const request = event.data as AppBridgeRequest;
      if (!request || typeof request !== 'object' || typeof request.id !== 'string') return;
      if (request.protocol !== APP_BRIDGE_PROTOCOL) return;

      const reply = (response: AppBridgeResponse) => {
        // '*' is correct here: the recipient has an opaque origin, so no
        // narrower target can be expressed. It is safe because the frame is
        // the only possible recipient of a message posted to its window.
        frameRef.current?.contentWindow?.postMessage(response, '*');
      };

      try {
        const result = await performAppBridgeRequest(orgId, request, scopes);
        note({
          at: Date.now(),
          kind: request.kind,
          table: tableForAppBridgeRequest(request),
          allowed: true,
          detail: 'ok',
        });
        reply({ protocol: APP_BRIDGE_PROTOCOL, id: request.id, ok: true, result });
      } catch (err) {
        const message = errorMessage(err);
        const allowed = !(err instanceof AppBridgeRefused);
        note({
          at: Date.now(),
          kind: request.kind,
          table: tableForAppBridgeRequest(request),
          allowed,
          detail: message,
        });
        reply({ protocol: APP_BRIDGE_PROTOCOL, id: request.id, ok: false, error: message });
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [note, orgId, scopes]);

  const refused = log.filter((entry) => !entry.allowed).length;

  return (
    <div className={styles.root} data-testid="app-runner">
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>{app.name}</h2>
          {/* Said in plain words, before anything runs: an app's permissions
              are only meaningful if a person can read them. */}
          <p className={styles.scopes}>{describeAppScopes(scopes)}</p>
          {webUrl ? (
            <a className={styles.webUrl} href={webUrl} target="_blank" rel="noreferrer">
              {webUrl}
            </a>
          ) : null}
        </div>
        <div className={styles.headActions}>
          {onEdit ? (
            <Button variant="ghost" onClick={onEdit} data-testid="app-edit">
              {t('apps.edit')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => setShowSend((open) => !open)}
            data-testid="app-send"
          >
            {t('apps.send')}
          </Button>
          <Button
            variant="ghost"
            disabled={publishing}
            onClick={() => {
              void (async () => {
                setPublishing(true);
                setError(null);
                try {
                  const published = await publishAppToWeb(orgId, app.id);
                  setWebUrl(published.url);
                  try {
                    await navigator.clipboard.writeText(published.url);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setPublishing(false);
                }
              })();
            }}
            data-testid="app-publish-web"
          >
            {publishing
              ? t('apps.publishingToWeb')
              : copied || webUrl
                ? t('apps.copyWebLink')
                : t('apps.publishToWeb')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowLog((prev) => !prev)}
            data-testid="app-toggle-log"
          >
            {t('apps.activity')}
            {refused > 0 ? <Badge tone="warning">{refused}</Badge> : null}
          </Button>
          <Button variant="ghost" onClick={onClose} data-testid="app-close">
            {t('apps.close')}
          </Button>
        </div>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {showSend ? (
        <div className={styles.sendPanel} data-testid="app-send-panel">
          <SendAppPicker
            orgId={orgId}
            app={app}
            onSkip={() => setShowSend(false)}
            onSent={() => setShowSend(false)}
          />
        </div>
      ) : null}

      <div className={styles.body}>
        <iframe
          ref={frameRef}
          className={styles.frame}
          title={app.name}
          srcDoc={srcDoc}
          // No allow-same-origin: the frame gets an opaque origin, so it
          // cannot read this page, its cookies, or its storage. Adding it
          // would undo the entire model.
          sandbox="allow-scripts allow-forms"
          onError={() => setError(t('apps.failedToRun'))}
        />

        {showLog ? (
          <aside className={styles.log} aria-label={t('apps.activity')}>
            <h3 className={styles.logTitle}>{t('apps.activity')}</h3>
            {log.length === 0 ? (
              <p className={styles.logEmpty}>{t('apps.noActivity')}</p>
            ) : (
              <ul className={styles.logList}>
                {log.map((entry, index) => (
                  <li
                    key={`${entry.at}-${index}`}
                    className={entry.allowed ? styles.logOk : styles.logRefused}
                  >
                    <span className={styles.logKind}>
                      {entry.kind}
                      {entry.table ? ` ${entry.table}` : ''}
                    </span>
                    <span className={styles.logDetail}>{entry.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
