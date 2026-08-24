import type { CSSProperties } from 'react';
import type { TeamChatAttachment } from '@open-design/contracts';
import { Badge } from '@open-design/components';
import { looksLikeUrl, resolveRichEmbed } from '../../runtime/rich-embed';
import {
  chatFileKind,
  extractMessageUrls,
  formatChatFileSize,
  splitMessageText,
} from '../../runtime/chat-media';
import { RichEmbed } from '../pages/RichEmbed';
import styles from './ChatMessageBody.module.css';

interface Props {
  body: string;
  attachments: TeamChatAttachment[];
  onOpenApp?: (attachment: TeamChatAttachment) => void;
}

export function ChatMessageBody({ body, attachments, onOpenApp }: Props) {
  const files = attachments.filter((attachment) => attachment.kind === 'file' || attachment.kind === 'link');
  const records = attachments.filter(
    (attachment) => attachment.kind !== 'file' && attachment.kind !== 'link',
  );
  const attachedUrls = new Set(
    files.map((attachment) => attachment.url).filter((url): url is string => Boolean(url)),
  );
  const unfurls = extractMessageUrls(body).filter((url) => !attachedUrls.has(url) && looksLikeUrl(url));

  return (
    <div className={styles.root}>
      {body ? (
        <p className={styles.body}>
          {splitMessageText(body).map((part, index) =>
            part.type === 'url' ? (
              <a
                key={`${part.value}-${index}`}
                className={styles.link}
                href={part.value}
                target="_blank"
                rel="noreferrer"
              >
                {part.value}
              </a>
            ) : (
              <span key={`t-${index}`}>{part.value}</span>
            ),
          )}
        </p>
      ) : null}

      {files.length > 0 ? (
        <div className={styles.media}>
          {files.map((attachment, index) => (
            <ChatFilePreview
              key={`${attachment.kind}-${attachment.id}-${index}`}
              attachment={attachment}
            />
          ))}
        </div>
      ) : null}

      {unfurls.map((url) => (
        <div key={url} className={styles.unfurl} data-testid="team-link-embed">
          {resolveRichEmbed(url) ? <RichEmbed url={url} compact /> : null}
        </div>
      ))}

      {records.length > 0 ? (
        <ul className={styles.records}>
          {records.map((attachment, index) => (
            <li key={`${attachment.kind}-${attachment.id}-${index}`}>
              {attachment.kind === 'app' && onOpenApp ? (
                <button
                  type="button"
                  className={styles.recordButton}
                  onClick={() => onOpenApp(attachment)}
                  data-testid={`team-app-attachment-${attachment.id}`}
                >
                  <Badge tone="info">{attachment.label}</Badge>
                </button>
              ) : (
                <Badge tone="info">{attachment.label}</Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChatFilePreview({ attachment }: { attachment: TeamChatAttachment }) {
  const url = attachment.url;
  if (!url) return <Badge tone="info">{attachment.label}</Badge>;
  if (attachment.kind === 'link') {
    return (
      <div className={styles.unfurl} data-testid={`team-file-${attachment.id}`}>
        <RichEmbed url={url} compact />
      </div>
    );
  }
  const kind = chatFileKind(attachment.mimeType, attachment.fileName ?? attachment.label);
  const name = attachment.fileName ?? attachment.label;
  const size = formatChatFileSize(attachment.byteSize);

  if (kind === 'image') {
    return (
      <a className={styles.imageLink} href={url} target="_blank" rel="noreferrer" data-testid={`team-file-${attachment.id}`}>
        <img className={styles.image} src={url} alt={name} />
      </a>
    );
  }
  if (kind === 'video') {
    return (
      <video className={styles.video} src={url} controls playsInline data-testid={`team-file-${attachment.id}`}>
        <a href={url}>{name}</a>
      </video>
    );
  }
  if (kind === 'audio') {
    return (
      <div className={styles.audioCard} data-testid={`team-file-${attachment.id}`}>
        <span className={styles.fileName}>{name}</span>
        <audio className={styles.audio} src={url} controls />
      </div>
    );
  }
  if (kind === 'pdf') {
    return (
      <div className={styles.pdfCard} data-testid={`team-file-${attachment.id}`}>
        <iframe className={styles.pdf} title={name} src={url} />
        <a className={styles.fileOpen} href={url} target="_blank" rel="noreferrer">
          {name}
        </a>
      </div>
    );
  }
  return (
    <a
      className={styles.fileCard}
      href={url}
      target="_blank"
      rel="noreferrer"
      data-testid={`team-file-${attachment.id}`}
      style={{ '--embed-accent': 'var(--chat-accent, #1164a3)' } as CSSProperties}
    >
      <span className={styles.fileGlyph} aria-hidden>
        {extensionGlyph(name)}
      </span>
      <span className={styles.fileCopy}>
        <strong>{name}</strong>
        <em>{[attachment.mimeType, size].filter(Boolean).join(' · ')}</em>
      </span>
    </a>
  );
}

function extensionGlyph(name: string): string {
  const ext = name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE';
  return ext || 'FILE';
}
