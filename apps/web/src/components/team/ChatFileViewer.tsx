import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, VisuallyHidden } from '@open-design/components';
import type { TeamChatAttachment } from '@open-design/contracts';
import { renderMarkdownToSafeHtml } from '../../artifacts/markdown';
import { useT } from '../../i18n';
import {
  chatFileKind,
  chatFileNeedsText,
  formatChatFileSize,
  parseChatCsv,
  readChatPreviewText,
  type ChatFileKind,
} from '../../runtime/chat-media';
import styles from './ChatFileViewer.module.css';

export interface ChatFileSource {
  id?: string;
  url: string;
  mimeType?: string;
  fileName: string;
  byteSize?: number;
  file?: File;
}

type Density = 'tile' | 'message' | 'lightbox';

const MEDIA_KINDS = new Set<ChatFileKind>(['video', 'audio', 'pdf', 'html']);

export function attachmentFileSource(attachment: TeamChatAttachment): ChatFileSource | null {
  if (!attachment.url) return null;
  return {
    id: attachment.id,
    url: attachment.url,
    mimeType: attachment.mimeType,
    fileName: attachment.fileName ?? attachment.label,
    byteSize: attachment.byteSize,
  };
}

export function ChatFilePreview({
  source,
  testId,
}: {
  source: ChatFileSource;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ChatFileStage
        source={source}
        density="message"
        testId={testId}
        onOpen={() => setOpen(true)}
      />
      {open ? <ChatFileLightbox source={source} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function PendingChatFile({
  file,
  onRemove,
  removeLabel,
}: {
  file: File;
  onRemove: () => void;
  removeLabel: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const src = URL.createObjectURL(file);
    setUrl(src);
    return () => URL.revokeObjectURL(src);
  }, [file]);
  const source: ChatFileSource | null = url
    ? {
        url,
        mimeType: file.type || undefined,
        fileName: file.name,
        byteSize: file.size,
        file,
      }
    : null;
  return (
    <li className={styles.pendingItem}>
      {source ? (
        <ChatFileStage
          source={source}
          density="tile"
          testId={`team-pending-${file.name}`}
          onOpen={() => setOpen(true)}
        />
      ) : null}
      <div className={styles.pendingMeta}>
        <span className={styles.fileName}>{file.name}</span>
        <em>{formatChatFileSize(file.size)}</em>
        <button type="button" className={styles.expandBtn} onClick={onRemove} aria-label={removeLabel}>
          ×
        </button>
      </div>
      {open && source ? <ChatFileLightbox source={source} onClose={() => setOpen(false)} /> : null}
    </li>
  );
}

export function ChatFileLightbox({
  source,
  onClose,
}: {
  source: ChatFileSource;
  onClose: () => void;
}) {
  const t = useT();
  const name = source.fileName;
  return (
    <Dialog
      className={styles.lightbox}
      ariaLabel={name}
      onClose={onClose}
      closeOnEscape
      data-testid="team-file-viewer"
    >
      <DialogHeader className={styles.lightboxHead}>
        <DialogTitle className={styles.lightboxTitle}>{name}</DialogTitle>
        <span className={styles.lightboxMeta}>{formatChatFileSize(source.byteSize)}</span>
      </DialogHeader>
      <DialogBody className={styles.lightboxBody}>
        <ChatFileStage source={source} density="lightbox" />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('team.closeFile')}
        </Button>
        <a className={styles.download} href={source.url} target="_blank" rel="noreferrer">
          {t('team.downloadFile')}
        </a>
      </DialogFooter>
    </Dialog>
  );
}

export function ChatFileStage({
  source,
  density,
  testId,
  onOpen,
}: {
  source: ChatFileSource;
  density: Density;
  testId?: string;
  onOpen?: () => void;
}) {
  const t = useT();
  const kind = chatFileKind(source.mimeType, source.fileName);
  const name = source.fileName;
  const size = formatChatFileSize(source.byteSize);
  const interactive = Boolean(onOpen) && density !== 'lightbox';
  const asButton = interactive && !MEDIA_KINDS.has(kind);

  let body: ReactNode;
  if (kind === 'image') {
    body = <img className={styles.image} src={source.url} alt={name} />;
  } else if (kind === 'video') {
    body = (
      <video className={styles.video} src={source.url} controls={density !== 'tile'} playsInline>
        <a href={source.url}>{name}</a>
      </video>
    );
  } else if (kind === 'audio') {
    body = (
      <div className={styles.audioCard}>
        <span className={styles.fileName}>{name}</span>
        <audio className={styles.audio} src={source.url} controls />
      </div>
    );
  } else if (kind === 'pdf') {
    body = <iframe className={styles.pdf} title={name} src={source.url} />;
  } else if (kind === 'font') {
    body = <FontPreview source={source} density={density} />;
  } else if (chatFileNeedsText(kind)) {
    body = <TextPreview source={source} kind={kind} density={density} />;
  } else {
    body = (
      <span className={styles.fileCopy}>
        <span className={styles.fileGlyph} aria-hidden>
          {extensionGlyph(name)}
        </span>
        {density === 'tile' ? null : (
          <span>
            <strong>{name}</strong>
            <em>{[source.mimeType, size].filter(Boolean).join(' · ')}</em>
          </span>
        )}
      </span>
    );
  }

  const className = [
    styles.stage,
    styles[`kind-${kind}`],
    styles[`density-${density}`],
    kind === 'file' ? styles.fileCard : '',
    asButton ? styles.openable : '',
  ].filter(Boolean).join(' ');

  if (asButton && onOpen) {
    return (
      <button
        type="button"
        className={className}
        onClick={onOpen}
        aria-label={t('team.viewFile')}
        data-testid={testId}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={`${className}${interactive ? ` ${styles.openable}` : ''}`} data-testid={testId}>
      {body}
      {interactive && onOpen ? (
        <button type="button" className={density === 'tile' ? styles.tileHit : styles.expandBtn} onClick={onOpen}>
          {density === 'tile' ? <VisuallyHidden>{t('team.viewFile')}</VisuallyHidden> : t('team.viewFile')}
        </button>
      ) : null}
    </div>
  );
}

function TextPreview({
  source,
  kind,
  density,
}: {
  source: ChatFileSource;
  kind: ChatFileKind;
  density: Density;
}) {
  const t = useT();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; text: string; truncated: boolean }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void readChatPreviewText(source)
      .then((result) => {
        if (!cancelled) setState({ status: 'ready', ...result });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [source.url, source.file, source.byteSize]);

  if (state.status === 'loading') {
    return <p className={styles.status}>{source.fileName}</p>;
  }
  if (state.status === 'error') {
    return <p className={styles.status}>{t('team.filePreviewError')}</p>;
  }

  const snippet = density === 'lightbox' ? state.text : state.text.slice(0, density === 'tile' ? 280 : 1200);
  const truncated = state.truncated || snippet.length < state.text.length;

  return (
    <div className={styles.document}>
      {kind === 'markdown' ? (
        <div
          className={styles.markdown}
          dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(snippet) }}
        />
      ) : null}
      {kind === 'html' ? (
        <iframe
          className={styles.html}
          title={source.fileName}
          sandbox=""
          srcDoc={snippet}
        />
      ) : null}
      {kind === 'csv' ? <CsvTable text={snippet} fileName={source.fileName} /> : null}
      {kind === 'json' ? <pre className={styles.code}><code>{prettyJson(snippet)}</code></pre> : null}
      {kind === 'code' || kind === 'text' ? (
        <pre className={styles.code}><code>{snippet}</code></pre>
      ) : null}
      {truncated && density === 'lightbox' ? (
        <p className={styles.truncated}>{t('team.fileTruncated')}</p>
      ) : null}
    </div>
  );
}

function CsvTable({ text, fileName }: { text: string; fileName: string }) {
  const delimiter = fileName.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  const rows = useMemo(() => parseChatCsv(text, delimiter), [delimiter, text]);
  if (rows.length === 0) return <pre className={styles.code}><code>{text}</code></pre>;
  const header = rows[0]!;
  const body = rows.slice(1);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {header.map((cell, index) => <th key={index}>{cell}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FontPreview({ source, density }: { source: ChatFileSource; density: Density }) {
  const family = `chat-font-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    const face = new FontFace(family, `url(${JSON.stringify(source.url)})`);
    void face.load().then((loaded) => document.fonts.add(loaded)).catch(() => undefined);
    return () => {
      document.fonts.forEach((item) => {
        if (item.family === family) document.fonts.delete(item);
      });
    };
  }, [family, source.url]);
  const sample = density === 'tile' ? 'Ag' : 'The quick brown fox jumps over the lazy dog 0123456789';
  return (
    <div className={styles.fontCard}>
      <span className={styles.fileName}>{source.fileName}</span>
      <p className={styles.fontSample} style={{ '--chat-preview-font': family } as CSSProperties}>
        {sample}
      </p>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function extensionGlyph(name: string): string {
  const ext = name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE';
  return ext || 'FILE';
}
