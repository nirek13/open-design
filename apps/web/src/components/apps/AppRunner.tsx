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
  APP_GMAIL_SCOPE_TABLE,
  describeAppScopes,
  scopeAllows,
  type AppBridgeRequest,
  type AppBridgeResponse,
  type OrgApp,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import {
  createWorkspaceRecord,
  fetchWorkspaceTables,
  publishAppToWeb,
  queryWorkspaceRecords,
  sendOrgMail,
  updateWorkspaceRecord,
} from '../../providers/registry';
import { APP_SDK_SOURCE } from './appSdk';
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

function tableForRequest(request: AppBridgeRequest): string | null {
  if (request.kind === 'mail.send') return APP_GMAIL_SCOPE_TABLE;
  return 'table' in request ? request.table : null;
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

  /** Carry out one request the app asked for, after it has been allowed. */
  const perform = useCallback(
    async (request: AppBridgeRequest): Promise<unknown> => {
      switch (request.kind) {
        case 'scopes':
          return { scopes };
        case 'describe': {
          const tables = await fetchWorkspaceTables(orgId);
          const table = tables.find((candidate) => candidate.name === request.table);
          if (!table) throw new Error(`no table '${request.table}'`);
          return {
            name: table.name,
            displayName: table.displayName,
            fields: table.fields.map((field) => ({
              name: field.name,
              displayName: field.displayName,
              type: field.type,
              required: field.required,
              options: (field.config as { options?: string[] } | null)?.options ?? null,
            })),
          };
        }
        case 'query': {
          const result = await queryWorkspaceRecords(orgId, request.table, {
            ...(request.filters ? { filters: request.filters as never } : {}),
            ...(request.sort ? { sort: request.sort } : {}),
            // Bounded regardless of what the app asked for: an app should not
            // be able to pull an entire org into a page in one call.
            limit: Math.min(Math.max(1, request.limit ?? 100), 500),
          });
          return { records: result.records };
        }
        case 'create': {
          const record = await createWorkspaceRecord(orgId, request.table, {
            data: request.data as never,
          });
          return { record };
        }
        case 'update': {
          const record = await updateWorkspaceRecord(orgId, request.recordId, {
            data: request.data as never,
          });
          return { record };
        }
        case 'mail.send': {
          const to = Array.isArray(request.to) ? request.to : [request.to];
          const cc = request.cc === undefined ? undefined : Array.isArray(request.cc) ? request.cc : [request.cc];
          const bcc = request.bcc === undefined ? undefined : Array.isArray(request.bcc) ? request.bcc : [request.bcc];
          return sendOrgMail(orgId, {
            to,
            cc,
            bcc,
            subject: typeof request.subject === 'string' ? request.subject : '',
            body: typeof request.body === 'string' ? request.body : '',
            isHtml: request.isHtml === true,
          });
        }
        default:
          // Unreachable while the union and the gate agree; refusing rather
          // than throwing keeps the failure direction safe if they drift.
          throw new Error('unsupported request');
      }
    },
    [orgId, scopes],
  );

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

      const decision = scopeAllows(scopes, request);
      if (!decision.allowed) {
        note({
          at: Date.now(),
          kind: request.kind,
          table: tableForRequest(request),
          allowed: false,
          detail: decision.reason ?? 'refused',
        });
        reply({
          protocol: APP_BRIDGE_PROTOCOL,
          id: request.id,
          ok: false,
          error: decision.reason ?? 'refused',
        });
        return;
      }

      try {
        const result = await perform(request);
        note({
          at: Date.now(),
          kind: request.kind,
          table: tableForRequest(request),
          allowed: true,
          detail: 'ok',
        });
        reply({ protocol: APP_BRIDGE_PROTOCOL, id: request.id, ok: true, result });
      } catch (err) {
        const message = errorMessage(err);
        note({
          at: Date.now(),
          kind: request.kind,
          table: tableForRequest(request),
          allowed: true,
          detail: message,
        });
        reply({ protocol: APP_BRIDGE_PROTOCOL, id: request.id, ok: false, error: message });
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [note, perform, scopes]);

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
