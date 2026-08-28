import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  PhoneChannel,
  PhoneChannelSecret,
  PhoneChannelsResponse,
  SlackChannel,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import styles from './PhoneChannelsPanel.module.css';

async function readJson<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message
      || resp.statusText
      || 'request failed';
    throw new Error(message);
  }
  return body as T;
}

export function PhoneChannelsPanel() {
  const t = useT();
  const [channels, setChannels] = useState<PhoneChannel[]>([]);
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSlackId, setSelectedSlackId] = useState('');
  const [replyUrl, setReplyUrl] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    const data = await readJson<PhoneChannelsResponse>(await fetch('/api/phone/channels'));
    setChannels(data.channels ?? []);
    setSlackConnected(Boolean(data.slackConnected));
    if (data.slackConnected) {
      const slack = await readJson<{ connected: boolean; channels: SlackChannel[] }>(
        await fetch('/api/phone/slack-channels'),
      );
      setSlackChannels(Array.isArray(slack.channels) ? slack.channels : []);
    } else {
      setSlackChannels([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const rememberSecret = (created: PhoneChannelSecret) => {
    setSecrets((current) => ({ ...current, [created.id]: created.inboundToken }));
    setChannels((current) => {
      const without = current.filter((channel) => channel.id !== created.id);
      return [created, ...without];
    });
  };

  const connectSlack = async () => {
    const selected = slackChannels.find((channel) => channel.id === selectedSlackId);
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const created = await readJson<PhoneChannelSecret>(await fetch('/api/phone/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'slack',
          slackChannelId: selected.id,
          slackChannelName: selected.name,
        }),
      }));
      rememberSecret(created);
      setSelectedSlackId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connectIMessage = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await readJson<PhoneChannelSecret>(await fetch('/api/phone/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'imessage',
          ...(replyUrl.trim() ? { replyUrl: replyUrl.trim() } : {}),
        }),
      }));
      rememberSecret(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await readJson<PhoneChannel>(await fetch(`/api/phone/channels/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      setChannels((current) => current.map((channel) => (channel.id === id ? updated : channel)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(`/api/phone/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok && resp.status !== 204) {
        await readJson(resp);
      }
      setChannels((current) => current.filter((channel) => channel.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
  };

  const slackOptions = useMemo(() => slackChannels, [slackChannels]);

  return (
    <section className={styles.panel} data-testid="phone-channels" aria-labelledby="phone-channels-title">
      <header className={styles.header}>
        <h2 id="phone-channels-title" className={styles.title}>{t('phone.title')}</h2>
        <p className={styles.lede}>{t('phone.lede')}</p>
      </header>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <div className={styles.actions}>
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>{t('phone.slack')}</h3>
          <p className={styles.cardBody}>{t('phone.slackBody')}</p>
          {slackConnected ? (
            <div className={styles.row}>
              <label className={styles.label}>
                <span>{t('phone.pickChannel')}</span>
                <select
                  className={styles.select}
                  value={selectedSlackId}
                  onChange={(event) => setSelectedSlackId(event.target.value)}
                  disabled={busy || loading}
                  aria-label={t('phone.pickChannel')}
                >
                  <option value="">{t('phone.channelPlaceholder')}</option>
                  {slackOptions.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.isIm || channel.isMpim ? 'DM' : '#'} {channel.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="primary"
                disabled={busy || !selectedSlackId}
                onClick={() => void connectSlack()}
              >
                {t('phone.connectSlack')}
              </Button>
            </div>
          ) : (
            <p className={styles.hint}>{t('phone.needSlack')}</p>
          )}
        </div>

        <div className={styles.card}>
          <h3 className={styles.cardTitle}>{t('phone.imessage')}</h3>
          <p className={styles.cardBody}>{t('phone.imessageBody')}</p>
          <label className={styles.label}>
            <span>{t('phone.replyUrl')}</span>
            <input
              className={styles.input}
              value={replyUrl}
              onChange={(event) => setReplyUrl(event.target.value)}
              placeholder={t('phone.replyUrlPlaceholder')}
              disabled={busy}
            />
            <span className={styles.hint}>{t('phone.replyUrlHint')}</span>
          </label>
          <Button variant="primary" disabled={busy} onClick={() => void connectIMessage()}>
            {t('phone.connectIMessage')}
          </Button>
        </div>
      </div>

      {loading ? <p className={styles.hint}>{t('phone.loading')}</p> : null}
      {!loading && channels.length === 0 ? <p className={styles.empty}>{t('phone.empty')}</p> : null}

      <ul className={styles.list}>
        {channels.map((channel) => {
          const secret = secrets[channel.id];
          const statusLabel =
            channel.status === 'paused'
              ? t('phone.status.paused')
              : channel.status === 'pairing'
                ? t('phone.status.pairing')
                : t('phone.status.active');
          return (
            <li key={channel.id} className={styles.item} data-testid={`phone-channel-${channel.kind}`}>
              <div className={styles.itemHead}>
                <strong>{channel.label}</strong>
                <span className={styles.status}>{statusLabel}</span>
              </div>
              {channel.pairingCode ? (
                <p className={styles.secret}>
                  {t('phone.pairingCode')}: <code>{channel.pairingCode}</code>
                  <span className={styles.hint}> {t('phone.pairingIMessage')}</span>
                </p>
              ) : null}
              <p className={styles.url}>
                <span>{t('phone.webhookUrl')}</span>
                <code>{channel.inboundUrl}</code>
                <Button variant="ghost" onClick={() => void copy(channel.inboundUrl)}>{t('phone.copy')}</Button>
              </p>
              {secret ? (
                <p className={styles.secret}>
                  {t('phone.secret')}: <code>{secret}</code>
                  <Button variant="ghost" onClick={() => void copy(secret)}>{t('phone.copy')}</Button>
                  <span className={styles.hint}> {t('phone.secretOnce')}</span>
                </p>
              ) : null}
              {channel.kind === 'imessage' ? (
                <p className={styles.help}>{t('phone.helpIMessage')}</p>
              ) : null}
              <div className={styles.itemActions}>
                {channel.status === 'paused' ? (
                  <Button variant="subtle" disabled={busy} onClick={() => void patch(channel.id, { status: 'active' })}>
                    {t('phone.resume')}
                  </Button>
                ) : (
                  <Button variant="subtle" disabled={busy} onClick={() => void patch(channel.id, { status: 'paused' })}>
                    {t('phone.pause')}
                  </Button>
                )}
                <Button variant="ghost" disabled={busy} onClick={() => void remove(channel.id)}>
                  {t('phone.remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
