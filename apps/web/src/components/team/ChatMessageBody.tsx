import type { TeamChatAttachment } from '@open-design/contracts';
import { Badge } from '@open-design/components';
import { looksLikeUrl, resolveRichEmbed } from '../../runtime/rich-embed';
import { extractMessageUrls } from '../../runtime/chat-media';
import { parseChatBlocks, parseChatInline } from '../../runtime/chat-format';
import { RichEmbed } from '../pages/RichEmbed';
import { attachmentFileSource, ChatFilePreview } from './ChatFileViewer';
import styles from './ChatMessageBody.module.css';

interface Props {
  body: string;
  attachments: TeamChatAttachment[];
  onOpenAttachment?: (attachment: TeamChatAttachment) => void;
}

const OPENABLE = new Set(['app', 'page', 'event']);

export function ChatMessageBody({ body, attachments, onOpenAttachment }: Props) {
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
          {files.map((attachment, index) => {
            const key = `${attachment.kind}-${attachment.id}-${index}`;
            if (attachment.kind === 'link' && attachment.url) {
              return (
                <div key={key} className={styles.unfurl} data-testid={`team-file-${attachment.id}`}>
                  <RichEmbed url={attachment.url} compact />
                </div>
              );
            }
            const source = attachmentFileSource(attachment);
            return source ? (
              <ChatFilePreview
                key={key}
                source={source}
                testId={`team-file-${attachment.id}`}
              />
            ) : (
              <Badge key={key} tone="info">
                {attachment.label}
              </Badge>
            );
          })}
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
              {OPENABLE.has(attachment.kind) && onOpenAttachment ? (
                <button
                  type="button"
                  className={styles.recordButton}
                  onClick={() => onOpenAttachment(attachment)}
                  data-testid={`team-${attachment.kind}-attachment-${attachment.id}`}
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
