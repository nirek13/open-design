'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input } from '@open-design/components';
import type { ChatChannel, OrgMember, OrgTeam } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  fetchChatChannels,
  fetchOrgMembers,
  fetchOrgTeams,
  setUpChatChannels,
} from '../../providers/registry';
import { navigate } from '../../router';
import type { SendDestination } from './sendToChat';
import styles from './SendAppPicker.module.css';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRoom(channel: ChatChannel): boolean {
  return channel.kind === 'channel';
}

function toggleId(prev: string[], id: string): string[] {
  return prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
}

export interface SendToChatPickerProps {
  orgId: string;
  name: string;
  onSend: (destinations: SendDestination[], body: string, exceptMemberIds: string[]) => Promise<string[]>;
  /** Heading override. Defaults to "Send {name}". */
  title?: string;
  lead?: string;
  exceptHint?: string;
  showSkip?: boolean;
  skipLabel?: string;
  onSkip?: () => void;
  onSent?: (channelRefs: string[]) => void;
  /** Prefix for data-testid values. Defaults to `send-app` so existing tests stay put. */
  testIdPrefix?: string;
}

export function SendToChatPicker({
  orgId,
  name,
  onSend,
  title,
  lead,
  exceptHint,
  showSkip = true,
  skipLabel,
  onSkip,
  onSent,
  testIdPrefix = 'send-app',
}: SendToChatPickerProps) {
  const t = useT();
  const { auth } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const viewerUserId = auth?.viewer?.userId ?? null;
  const id = (suffix: string) => `${testIdPrefix}-${suffix}`;

  const [people, setPeople] = useState<OrgMember[]>([]);
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [query, setQuery] = useState('');
  const [pickedPeople, setPickedPeople] = useState<string[]>([]);
  const [pickedTeams, setPickedTeams] = useState<string[]>([]);
  const [pickedChannels, setPickedChannels] = useState<string[]>([]);
  const [exceptPeople, setExceptPeople] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentRefs, setSentRefs] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [members, orgTeams, chat] = await Promise.all([
          fetchOrgMembers(orgId),
          fetchOrgTeams(orgId).catch(() => [] as OrgTeam[]),
          fetchChatChannels(orgId),
        ]);
        let rooms = chat.channels.filter((channel) => isRoom(channel) && !channel.archivedAt);
        if (rooms.length === 0) {
          try {
            const seeded = await setUpChatChannels(orgId);
            rooms = seeded.filter((channel) => isRoom(channel) && !channel.archivedAt);
          } catch {
            // Sending to people still works without default channels.
          }
        }
        if (cancelled) return;
        setPeople(members.filter((member) => member.status === 'active'));
        setTeams(orgTeams);
        setChannels(rooms.filter((channel) => channel.visibility === 'public' || channel.joined));
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const coworkers = useMemo(
    () => people.filter((person) => person.userId !== viewerUserId),
    [people, viewerUserId],
  );

  const needle = query.trim().toLowerCase();
  const shownPeople = useMemo(() => {
    if (!needle) return coworkers;
    return coworkers.filter((person) => {
      const blob = `${person.displayName} ${person.username ?? ''} ${person.email ?? ''}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [coworkers, needle]);

  const shownTeams = useMemo(() => {
    if (!needle) return teams;
    return teams.filter((team) => {
      const blob = `${team.name} ${team.slug} ${team.description ?? ''}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [needle, teams]);

  const shownChannels = useMemo(() => {
    if (!needle) return channels;
    return channels.filter((channel) => {
      const blob = `${channel.displayName} ${channel.slug}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [channels, needle]);

  const pickPerson = (memberId: string) => {
    setPickedPeople((prev) => toggleId(prev, memberId));
    setExceptPeople((prev) => prev.filter((id) => id !== memberId));
    setSentRefs(null);
  };

  const pickTeam = (teamId: string) => {
    setPickedTeams((prev) => toggleId(prev, teamId));
    setSentRefs(null);
  };

  const pickChannel = (channelRef: string) => {
    setPickedChannels((prev) => toggleId(prev, channelRef));
    setSentRefs(null);
  };

  const exceptPerson = (memberId: string) => {
    setExceptPeople((prev) => toggleId(prev, memberId));
    setPickedPeople((prev) => prev.filter((id) => id !== memberId));
    setSentRefs(null);
  };

  const send = useCallback(async () => {
    const destinations: SendDestination[] = [
      ...pickedPeople.map((memberId) => ({ kind: 'person' as const, memberId })),
      ...pickedTeams.map((teamId) => ({ kind: 'team' as const, teamId })),
      ...pickedChannels.map((channelRef) => ({ kind: 'channel' as const, channelRef })),
    ];
    if (destinations.length === 0 && exceptPeople.length === 0) {
      setError(t('apps.send.needPick'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = note.trim() || t('apps.send.defaultBody', { name });
      const refs = await onSend(destinations, body, exceptPeople);
      setSentRefs(refs);
      onSent?.(refs);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [exceptPeople, name, note, onSend, onSent, pickedChannels, pickedPeople, pickedTeams, t]);

  const lastRef = sentRefs?.[0] ?? null;
  const canSend =
    pickedPeople.length > 0
    || pickedTeams.length > 0
    || pickedChannels.length > 0
    || exceptPeople.length > 0;

  return (
    <div className={styles.root} data-testid={id('picker')}>
      <h3 className={styles.title}>{title ?? t('apps.send.title', { name })}</h3>
      <p className={styles.lead}>{lead ?? t('apps.send.lead')}</p>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {sentRefs ? (
        <p className={styles.sent} data-testid={id('sent')}>
          {t('apps.send.sent')}
        </p>
      ) : null}

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('apps.send.search')}
        aria-label={t('apps.send.search')}
        data-testid={id('search')}
      />

      {shownPeople.length === 0 && shownTeams.length === 0 && shownChannels.length === 0 ? (
        <p className={styles.empty}>{t('apps.send.empty')}</p>
      ) : (
        <div className={styles.columns}>
          {shownPeople.length > 0 ? (
            <section className={styles.column}>
              <h4 className={styles.section}>{t('apps.send.people')}</h4>
              <ul className={styles.list}>
                {shownPeople.map((person) => {
                  const selected = pickedPeople.includes(person.id);
                  return (
                    <li key={person.id}>
                      <button
                        type="button"
                        className={selected ? styles.chipOn : styles.chip}
                        aria-pressed={selected}
                        data-testid={id(`person-${person.id}`)}
                        onClick={() => pickPerson(person.id)}
                      >
                        {person.displayName || person.username || person.email || person.id}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {shownTeams.length > 0 ? (
            <section className={styles.column}>
              <h4 className={styles.section}>{t('apps.send.teams')}</h4>
              <ul className={styles.list}>
                {shownTeams.map((team) => {
                  const selected = pickedTeams.includes(team.id);
                  return (
                    <li key={team.id}>
                      <button
                        type="button"
                        className={selected ? styles.chipOn : styles.chip}
                        aria-pressed={selected}
                        data-testid={id(`team-${team.id}`)}
                        onClick={() => pickTeam(team.id)}
                      >
                        {team.name}
                        <span className={styles.chipMeta}>{team.memberIds.length}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {shownChannels.length > 0 ? (
            <section className={styles.column}>
              <h4 className={styles.section}>{t('apps.send.channels')}</h4>
              <ul className={styles.list}>
                {shownChannels.map((channel) => {
                  const selected = pickedChannels.includes(channel.slug);
                  return (
                    <li key={channel.id}>
                      <button
                        type="button"
                        className={selected ? styles.chipOn : styles.chip}
                        aria-pressed={selected}
                        data-testid={id(`channel-${channel.slug}`)}
                        onClick={() => pickChannel(channel.slug)}
                      >
                        #{channel.displayName}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {coworkers.length > 0 ? (
        <section className={styles.except} data-testid={id('except')}>
          <h4 className={styles.section}>{t('apps.send.except')}</h4>
          <p className={styles.exceptHint}>{exceptHint ?? t('apps.send.exceptHint')}</p>
          <ul className={styles.list}>
            {shownPeople.map((person) => {
              const selected = exceptPeople.includes(person.id);
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    className={selected ? styles.chipExcept : styles.chip}
                    aria-pressed={selected}
                    data-testid={id(`except-${person.id}`)}
                    onClick={() => exceptPerson(person.id)}
                  >
                    {person.displayName || person.username || person.email || person.id}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <label className={styles.note}>
        {t('apps.send.note')}
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('apps.send.notePlaceholder')}
          data-testid={id('note')}
        />
      </label>

      <div className={styles.footer}>
        {showSkip ? (
          <Button variant="ghost" onClick={onSkip} data-testid={id('skip')}>
            {skipLabel ?? t('apps.send.skip')}
          </Button>
        ) : null}
        {lastRef ? (
          <Button
            variant="ghost"
            onClick={() => navigate({ kind: 'home', view: 'slack', channelId: lastRef })}
            data-testid={id('open-chat')}
          >
            {t('apps.send.openChat')}
          </Button>
        ) : null}
        <Button
          disabled={busy || !canSend}
          onClick={() => void send()}
          data-testid={id('submit')}
        >
          {busy ? t('apps.send.sending') : t('apps.send.action')}
        </Button>
      </div>
    </div>
  );
}
