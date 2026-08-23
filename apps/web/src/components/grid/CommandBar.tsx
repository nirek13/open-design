// Say what you want.
//
// One box that turns a sentence into a change. The interaction is deliberately
// two-step: interpreting shows what would happen and applying is a separate
// press, so a misread instruction costs a glance rather than a recovery.
//
// The confidence number is shown, not hidden behind a threshold. A parser that
// is 60% sure should look 60% sure — the alternative is a UI that presents a
// guess with the same certainty as a match, which is how wrong changes get
// approved.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input } from '@open-design/components';
import {
  MIN_APPLY_CONFIDENCE,
  type InterpretIntentResponse,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { applyIntent, interpretIntent } from '../../providers/registry';
import styles from './CommandBar.module.css';

interface Props {
  orgId: string;
  /** The table on screen, so "add a phone column" needs no table named. */
  tableRef?: string;
  /** Called after a change is applied, so the caller can reload. */
  onApplied?: () => void;
  /** Called when the sentence was a question rather than a change. */
  onQuery?: (plan: NonNullable<InterpretIntentResponse['query']>) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CommandBar({ orgId, tableRef, onApplied, onQuery }: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const [result, setResult] = useState<InterpretIntentResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Interpreting is cheap and local, but not free — wait for a pause in typing
  // rather than firing on every keystroke.
  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await interpretIntent(orgId, trimmed, tableRef);
        if (!cancelled) {
          setResult(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [orgId, tableRef, text]);

  const submit = useCallback(async () => {
    if (!result) return;

    if (result.kind === 'query' && result.query) {
      onQuery?.(result.query);
      setText('');
      setResult(null);
      return;
    }
    if (result.operations.length === 0) return;

    setBusy(true);
    try {
      await applyIntent(orgId, text.trim(), result.operations, true);
      setText('');
      setResult(null);
      onApplied?.();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [onApplied, onQuery, orgId, result, text]);

  const canApply =
    result !== null &&
    result.kind !== 'unsupported' &&
    (result.kind === 'query' || result.operations.length > 0) &&
    result.confidence >= MIN_APPLY_CONFIDENCE;

  const tone =
    result === null
      ? undefined
      : result.kind === 'unsupported'
        ? styles.unsure
        : result.confidence >= 0.85
          ? styles.sure
          : styles.hedged;

  return (
    <div className={styles.root} data-testid="command-bar">
      <form
        className={styles.row}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('command.placeholder')}
          aria-label={t('command.placeholder')}
          data-testid="command-input"
        />
        <Button type="submit" disabled={!canApply || busy} data-testid="command-run">
          {busy ? t('command.working') : result?.kind === 'query' ? t('command.show') : t('command.apply')}
        </Button>
      </form>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className={`${styles.readback} ${tone ?? ''}`} data-testid="command-readback">
          <p className={styles.summary}>{result.summary}</p>

          {result.kind !== 'unsupported' ? (
            <p className={styles.meta}>
              {/* Shown as a number because "fairly sure" means different things
                  to different people, and this is a decision about data. */}
              {t('command.confidence', { percent: String(Math.round(result.confidence * 100)) })}
              {result.confidence < MIN_APPLY_CONFIDENCE ? ` — ${t('command.tooUnsure')}` : ''}
            </p>
          ) : null}

          {result.unmatched ? (
            <p className={styles.unmatched}>
              {t('command.ignored', { text: result.unmatched })}
            </p>
          ) : null}

          {result.preview && result.preview.lines.length > 0 ? (
            <ul className={styles.preview}>
              {result.preview.lines.map((line, index) => (
                <li key={`${line.summary}-${index}`}>
                  {line.summary}
                  {line.detail ? <span className={styles.detail}> — {line.detail}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {result.preview?.warnings.map((warning) => (
            <p key={warning} className={styles.warning}>
              {warning}
            </p>
          ))}

          {result.suggestions.length > 0 ? (
            <div className={styles.suggestions}>
              <span className={styles.suggestionsLabel}>{t('command.tryLabel')}</span>
              {result.suggestions.slice(0, 4).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => {
                    setText(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
