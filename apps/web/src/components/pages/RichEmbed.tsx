import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { iframeSnippet, resolveRichEmbed, type RichEmbedModel } from '../../runtime/rich-embed';
import {
  PAGE_MAKE_ACTIONS,
  pageMakeAction,
  type PageMakeKind,
} from '../../runtime/page-make';
import { CreatedWorkPicker } from './CreatedWorkPicker';
import styles from './RichEmbed.module.css';

interface Props {
  url: string;
  onClear?: () => void;
  compact?: boolean;
}

export function RichEmbed({ url, onClear, compact = false }: Props) {
  const model = useMemo(() => resolveRichEmbed(url), [url]);
  const [copied, setCopied] = useState(false);

  if (!model) {
    return (
      <div className={styles.card} data-testid="pages-rich-embed">
        <p className={styles.fallback}>Could not preview this link.</p>
        <a className={styles.open} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(iframeSnippet(model));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <figure
      className={compact ? `${styles.frame} ${styles.compact}` : styles.frame}
      data-testid="pages-rich-embed"
      data-kind={model.kind}
      data-provider={model.provider}
      style={{ '--embed-accent': model.accent } as CSSProperties}
    >
      <figcaption className={styles.bar}>
        <span className={styles.badge}>{model.provider}</span>
        <span className={styles.title}>{model.title}</span>
        <div className={styles.actions}>
          {compact ? null : model.kind !== 'card' ? (
            <button type="button" className={styles.action} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy embed'}
            </button>
          ) : null}
          <a className={styles.action} href={model.openUrl} target="_blank" rel="noreferrer">
            Open
          </a>
          {onClear && !compact ? (
            <button type="button" className={styles.action} onClick={onClear}>
              Replace
            </button>
          ) : null}
        </div>
      </figcaption>
      <div
        className={styles.stage}
        style={model.aspect === 'auto' ? undefined : { aspectRatio: model.aspect }}
        data-kind={model.kind}
      >
        <EmbedBody model={model} />
      </div>
    </figure>
  );
}

function EmbedBody({ model }: { model: RichEmbedModel }) {
  if (model.kind === 'image') {
    return <img className={styles.media} src={model.src} alt={model.title} />;
  }
  if (model.kind === 'video') {
    return <video className={styles.media} src={model.src} controls playsInline />;
  }
  if (model.kind === 'audio') {
    return <audio className={styles.media} src={model.src} controls />;
  }
  if (model.kind === 'pdf') {
    return (
      <iframe
        className={styles.frameInner}
        title={model.title}
        src={model.src}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    );
  }
  if (model.kind === 'iframe') {
    return (
      <iframe
        className={styles.frameInner}
        title={model.title}
        src={model.src}
        allow={model.allow}
        sandbox={model.sandbox}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
      />
    );
  }
  return (
    <a className={styles.card} href={model.openUrl} target="_blank" rel="noreferrer">
      <span className={styles.cardMark} aria-hidden>
        {model.provider.slice(0, 1)}
      </span>
      <span className={styles.cardCopy}>
        <strong>{model.title}</strong>
        <em>{hostOf(model.openUrl)}</em>
      </span>
    </a>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function EmbedComposer({
  value,
  orgId,
  initialMakeKind,
  onSubmit,
  onMake,
}: {
  value?: string;
  orgId?: string | null;
  initialMakeKind?: PageMakeKind | null;
  onSubmit: (url: string) => void;
  onMake?: (kind: PageMakeKind, prompt: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const [makeKind, setMakeKind] = useState<PageMakeKind | null>(initialMakeKind ?? null);
  const [makePrompt, setMakePrompt] = useState('');
  const action = makeKind ? pageMakeAction(makeKind) : null;

  const commit = (event?: FormEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (!next) return;
    onSubmit(next);
  };

  const commitMake = (event?: FormEvent) => {
    event?.preventDefault();
    const next = makePrompt.trim();
    if (!next || !makeKind) return;
    onMake?.(makeKind, next);
  };

  return (
    <div className={styles.composerWrap}>
      {onMake ? (
        <div className={styles.makeBar} data-testid="pages-make-bar">
          <span className={styles.makeLabel}>Make something unique</span>
          <div className={styles.makeChips}>
            {PAGE_MAKE_ACTIONS.map((item) => (
              <button
                key={item.kind}
                type="button"
                className={styles.makeChip}
                data-active={makeKind === item.kind}
                data-testid={`pages-make-chip-${item.kind}`}
                onClick={() => setMakeKind(item.kind === makeKind ? null : item.kind)}
              >
                {item.glyph} {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {action && onMake ? (
        <form className={styles.composer} onSubmit={commitMake} data-testid="pages-make-composer">
          <input
            className={styles.composerInput}
            value={makePrompt}
            onChange={(event) => setMakePrompt(event.target.value)}
            placeholder={`Describe the unique ${action.noun}…`}
            aria-label={`Describe the unique ${action.noun}`}
            autoComplete="off"
            autoFocus={Boolean(initialMakeKind)}
          />
          <button type="submit" className={styles.composerHint}>
            Make
          </button>
        </form>
      ) : (
        <form className={styles.composer} onSubmit={commit} data-testid="pages-embed-composer">
          <input
            className={styles.composerInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste a URL, or pick an app, picture, video, or slides you created"
            aria-label="Embed URL"
            autoComplete="off"
          />
          <span className={styles.composerHint}>Embed</span>
        </form>
      )}
      {orgId && !makeKind ? (
        <CreatedWorkPicker orgId={orgId} query={draft} onPick={onSubmit} />
      ) : null}
    </div>
  );
}
