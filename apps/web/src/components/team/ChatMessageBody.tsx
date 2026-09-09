import type { ChatUserGroup, TeamChatAttachment } from '@open-design/contracts';
import { Badge } from '@open-design/components';
import { looksLikeUrl, resolveRichEmbed } from '../../runtime/rich-embed';
import { extractMessageUrls } from '../../runtime/chat-media';
import { parseChatBlocks, parseChatInline } from '../../runtime/chat-format';
import { RichEmbed } from '../pages/RichEmbed';
import { attachmentFileSource, ChatFilePreview } from './ChatFileViewer';
import { splitCustomEmoji, useChatEmoji, type ChatEmojiLookup } from './ChatEmojiContext';
import styles from './ChatMessageBody.module.css';

interface Props {
  body: string;
  attachments: TeamChatAttachment[];
  onOpenAttachment?: (attachment: TeamChatAttachment) => void;
  /** Groups whose handles should render as a chip rather than plain text.
   * Optional so a body rendered outside a chat view still reads correctly. */
  groups?: readonly ChatUserGroup[];
  /** Highlighted when the message names the viewer. */
  selfHandles?: readonly string[];
}

const OPENABLE = new Set(['app', 'page', 'event']);

export function ChatMessageBody({ body, attachments, onOpenAttachment, groups, selfHandles }: Props) {
  const emoji = useChatEmoji();
  const files = attachments.filter((attachment) => attachment.kind === 'file' || attachment.kind === 'link');
  // A forward renders as a quoted card rather than as a chip in the row of
  // record links: it is the message, not an annotation on one.
  const quotes = attachments.filter((attachment) => attachment.kind === 'message');
  const records = attachments.filter(
    (attachment) =>
      attachment.kind !== 'file' && attachment.kind !== 'link' && attachment.kind !== 'message',
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
                  <Inline text={block.text} emoji={emoji} groups={groups} selfHandles={selfHandles} />
                </blockquote>
              );
            }
            if (block.kind === 'list') {
              return (
                <ul key={index} className={styles.list}>
                  {(block.items ?? []).map((item, itemIndex) => (
                    <li key={itemIndex}><Inline text={item} emoji={emoji} groups={groups} selfHandles={selfHandles} /></li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={index} className={styles.paragraph}>
                <Inline text={block.text} emoji={emoji} groups={groups} selfHandles={selfHandles} />
              </p>
            );
          })}
        </div>
      ) : null}

      {quotes.map((attachment, index) => (
        <blockquote
          key={`quote-${attachment.id}-${index}`}
          className={styles.forward}
          data-testid={`team-forward-${attachment.id}`}
        >
          <p className={styles.forwardMeta}>
            {attachment.quote?.authorName ?? ''}
            {attachment.quote?.channelSlug ? ` · #${attachment.quote.channelSlug}` : ''}
          </p>
          <Inline
            text={attachment.quote?.body ?? attachment.label}
            emoji={emoji}
            groups={groups}
            selfHandles={selfHandles}
          />
        </blockquote>
      ))}

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

function Inline({
  text,
  emoji,
  groups,
  selfHandles,
}: {
  text: string;
  emoji: ChatEmojiLookup;
  groups?: readonly ChatUserGroup[];
  selfHandles?: readonly string[];
}) {
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
          const handle = part.value.replace(/^@/, '').toLowerCase();
          const group = groups?.find((item) => item.handle === handle);
          // Being named yourself is the one thing in a transcript worth
          // catching the eye, so it gets its own class rather than the
          // ordinary mention colour.
          const mine = selfHandles?.some((self) => self.toLowerCase() === handle)
            || handle === 'channel'
            || handle === 'here'
            || handle === 'everyone';
          return (
            <span
              key={index}
              className={`${styles.mention}${mine ? ` ${styles.mentionSelf}` : ''}`}
              title={group ? `${group.name} · ${group.memberIds.length} people` : undefined}
            >
              {part.value}
            </span>
          );
        }
        if (part.kind === 'code') {
          return <code key={index} className={styles.code}>{part.value}</code>;
        }
        if (part.kind === 'bold') {
          return <strong key={index}><EmojiText text={part.value} emoji={emoji} /></strong>;
        }
        if (part.kind === 'italic') {
          return <em key={index}><EmojiText text={part.value} emoji={emoji} /></em>;
        }
        if (part.kind === 'strike') {
          return <s key={index}><EmojiText text={part.value} emoji={emoji} /></s>;
        }
        return <EmojiText key={index} text={part.value} emoji={emoji} />;
      })}
    </>
  );
}

/** Swap `:shipit:` for the image the organization uploaded. Text with no
 * custom emoji in it comes back as one span, so the common case costs one
 * `includes(':')` and nothing else. */
function EmojiText({ text, emoji }: { text: string; emoji: ChatEmojiLookup }) {
  const parts = splitCustomEmoji(text, emoji);
  if (parts.length === 1 && parts[0]?.kind === 'text') return <span>{parts[0].value}</span>;
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'emoji' ? (
          <img
            key={index}
            className={styles.customEmoji}
            src={part.url}
            alt={`:${part.name}:`}
            title={`:${part.name}:`}
            loading="lazy"
          />
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}
