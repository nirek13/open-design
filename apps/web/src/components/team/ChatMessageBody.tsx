import type { CSSProperties } from 'react';
import type { TeamChatAttachment } from '@open-design/contracts';
import { Badge } from '@open-design/components';
import { looksLikeUrl, resolveRichEmbed } from '../../runtime/rich-embed';
import {
  chatFileKind,
  extractMessageUrls,
  formatChatFileSize,
} from '../../runtime/chat-media';
import { parseChatBlocks, parseChatInline } from '../../runtime/chat-format';
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
  const blocks = parseChatBlocks(body);

  return (
    <div className={styles.root}>
      {body ? (
        <div className={styles.body}>
          {blocks.map((block, index) => {
            if (block.kind === 'code') {
              return (
                <pre key={index} className={styles.codeBlock}>
                  <code>{block.text}</code>
                </pre>
              );
            }
            if (block.kind === 'quote') {
              return (
                <blockquote key={index} className={styles.quote}>
                  <Inline text={block.text} />
                </blockquote>
              );
            }
            if (block.kind === 'list') {
              return (
                <ul key={index} className={styles.list}>
                  {(block.items ?? []).map((item, itemIndex) => (
                    <li key={itemIndex}><Inline text={item} /></li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={index} className={styles.paragraph}>
                <Inline text={block.text} />
              </p>
            );
          })}
        </div>
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

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseChatInline(text).map((part, index) => {
        if (part.kind === 'url') {
          return (
            <a key={index} className={styles.link} href={part.value} target="_blank" rel="noreferrer">
              {part.value}
            </a>
          );
        }
        if (part.kind === 'mention') {
          return <span key={index} className={styles.mention}>{part.value}</span>;
        }
        if (part.kind === 'code') {
          return <code key={index} className={styles.code}>{part.value}</code>;
        }
        if (part.kind === 'bold') {
          return <strong key={index}>{part.value}</strong>;
        }
        if (part.kind === 'italic') {
          return <em key={index}>{part.value}</em>;
        }
        if (part.kind === 'strike') {
          return <s key={index}>{part.value}</s>;
        }
        return <span key={index}>{part.value}</span>;
      })}
    </>
  );
}
