// What the composer should offer, given what has been typed so far.
//
// Four triggers, one mechanism: `@` for people and groups, `#` for channels,
// `:` for emoji, and a leading `/` for commands. They share a module because
// they share the hard part — deciding whether the caret is actually inside a
// token, and where that token starts — and getting that wrong in four separate
// places is how a composer ends up popping a menu in the middle of an email
// address.
//
// Pure functions over (text, caret). No React, no fetch: the view supplies the
// candidate lists it already has, and gets back what to show and what to
// replace. That keeps this testable without a DOM and keeps the composer from
// growing a second copy of the matching rules.

import type { ChatChannel, ChatCustomEmoji, ChatUserGroup, OrgMember } from '@open-design/contracts';
import { CHAT_EMOJI_GROUPS } from './chat-emoji';
import { SLASH_HELP } from './chat-format';

export type ChatSuggestionKind = 'person' | 'group' | 'channel' | 'emoji' | 'command' | 'special';

export interface ChatSuggestion {
  kind: ChatSuggestionKind;
  /** Stable key for React, and the id the caller may need (member id, channel
   * slug). Not what gets inserted. */
  id: string;
  /** Primary line — `@ada`, `#deals-emea`, `:shipit:`. */
  label: string;
  /** Secondary line: a real name, a channel topic, what a command does. */
  hint?: string;
  /** Rendered ahead of the label: a unicode emoji, or a custom emoji URL. */
  icon?: string;
  iconUrl?: string;
  /** The text that replaces the token, without the trailing space the caller
   * adds. */
  insert: string;
}

export interface ChatAutocompleteQuery {
  trigger: '@' | '#' | ':' | '/';
  /** What has been typed after the trigger, lowercased. */
  term: string;
  /** Caret-relative bounds of the token being replaced, trigger included. */
  start: number;
  end: number;
}

/** A token boundary is the start of the line or whitespace — never mid-word.
 * Without this, `me@example.com` opens the people menu and `a:b` opens the
 * emoji menu, both of which are worse than offering nothing. */
const TRIGGER_RE = /(?:^|[\s(\[{])([@#:])([\p{L}\p{N}._+-]*)$/u;

/** Read the token the caret sits in, if any. */
export function readChatAutocomplete(text: string, caret: number): ChatAutocompleteQuery | null {
  const before = text.slice(0, caret);

  // A slash command is only a command at the very start of the message. `/`
  // anywhere else is a date, a path, or a fraction.
  const slash = /^\/([a-z]*)$/i.exec(before);
  if (slash) {
    return { trigger: '/', term: slash[1]!.toLowerCase(), start: 0, end: caret };
  }

  const match = TRIGGER_RE.exec(before);
  if (!match) return null;
  const trigger = match[1] as '@' | '#' | ':';
  const term = match[2] ?? '';
  // `:` needs at least two characters before it means anything. Otherwise
  // every colon in prose — "note: this" — opens a menu.
  if (trigger === ':' && term.length < 2) return null;
  return {
    trigger,
    term: term.toLowerCase(),
    start: caret - term.length - 1,
    end: caret,
  };
}

/** Replace the matched token with a suggestion, leaving the caret after it.
 * Returns both the new text and the new caret so the caller does not have to
 * recompute a position it already knows. */
export function applyChatSuggestion(
  text: string,
  query: ChatAutocompleteQuery,
  suggestion: ChatSuggestion,
): { text: string; caret: number } {
  const insert = `${suggestion.insert} `;
  return {
    text: `${text.slice(0, query.start)}${insert}${text.slice(query.end)}`,
    caret: query.start + insert.length,
  };
}

function scoreMatch(haystack: string, term: string): number {
  if (!term) return 1;
  const value = haystack.toLowerCase();
  if (value === term) return 4;
  if (value.startsWith(term)) return 3;
  if (value.includes(term)) return 2;
  return 0;
}

export interface ChatSuggestionSources {
  people: readonly OrgMember[];
  groups: readonly ChatUserGroup[];
  channels: readonly ChatChannel[];
  customEmoji: readonly ChatCustomEmoji[];
  /** Excluded from the people list — offering to mention yourself is noise. */
  selfMemberId?: string | null;
}

/** The commands the composer offers. Derived from the help text so the menu
 * and `/help` cannot list different things. */
const COMMANDS: ReadonlyArray<{ name: string; hint: string }> = SLASH_HELP.split('\n')
  .map((line) => {
    const [names, ...rest] = line.split(' — ');
    return { name: (names ?? '').trim().split(/\s+/)[0]!.replace(/^\//, ''), hint: rest.join(' — ') };
  })
  .filter((entry) => entry.name.length > 0);

const SPECIAL_MENTIONS: ReadonlyArray<{ token: string; hint: string }> = [
  { token: 'channel', hint: 'Notify everyone in this channel' },
  { token: 'here', hint: 'Notify everyone who is active right now' },
  { token: 'everyone', hint: 'Notify every member of the organization' },
];

/** Unicode emoji, flattened once from the picker groups so the `:` menu and
 * the picker offer the same set. */
const UNICODE_EMOJI: ReadonlyArray<{ name: string; char: string }> = CHAT_EMOJI_GROUPS.flatMap(
  (group) =>
    group.emoji.map((char, index) => ({
      // The picker is a grid of characters with no names attached, so a name
      // is synthesised from its group. Good enough to be searchable by group —
      // `:work` finds the work emoji — without shipping a full emoji lexicon.
      name: `${group.label.toLowerCase()}_${index + 1}`,
      char,
    })),
);

const MAX_SUGGESTIONS = 8;

/** Everything the composer should offer for this token, best match first. */
export function chatSuggestions(
  query: ChatAutocompleteQuery,
  sources: ChatSuggestionSources,
): ChatSuggestion[] {
  const term = query.term;
  const out: Array<ChatSuggestion & { score: number }> = [];

  if (query.trigger === '@') {
    for (const special of SPECIAL_MENTIONS) {
      const score = scoreMatch(special.token, term);
      if (score > 0) {
        out.push({
          score: score + 0.5,
          kind: 'special',
          id: `@${special.token}`,
          label: `@${special.token}`,
          hint: special.hint,
          insert: `@${special.token}`,
        });
      }
    }
    for (const group of sources.groups) {
      const score = Math.max(scoreMatch(group.handle, term), scoreMatch(group.name, term));
      if (score > 0) {
        out.push({
          score,
          kind: 'group',
          id: group.id,
          label: `@${group.handle}`,
          hint: `${group.name} · ${group.memberIds.length} people`,
          insert: `@${group.handle}`,
        });
      }
    }
    for (const person of sources.people) {
      if (person.id === sources.selfMemberId) continue;
      const handle = person.username || person.displayName?.replace(/\s+/g, '').toLowerCase() || '';
      if (!handle) continue;
      const score = Math.max(scoreMatch(handle, term), scoreMatch(person.displayName ?? '', term));
      if (score > 0) {
        out.push({
          score,
          kind: 'person',
          id: person.id,
          label: `@${handle}`,
          ...(person.displayName ? { hint: person.displayName } : {}),
          insert: `@${handle}`,
        });
      }
    }
  }

  if (query.trigger === '#') {
    for (const channel of sources.channels) {
      if (channel.kind !== 'channel' || channel.archivedAt) continue;
      const score = Math.max(scoreMatch(channel.slug, term), scoreMatch(channel.displayName, term));
      if (score > 0) {
        out.push({
          score: score + (channel.joined ? 0.5 : 0),
          kind: 'channel',
          id: channel.slug,
          label: `#${channel.slug}`,
          ...(channel.topic ? { hint: channel.topic } : {}),
          insert: `#${channel.slug}`,
        });
      }
    }
  }

  if (query.trigger === ':') {
    for (const emoji of sources.customEmoji) {
      const score = scoreMatch(emoji.name, term);
      if (score > 0) {
        out.push({
          score: score + 1, // The organization's own emoji rank above stock ones.
          kind: 'emoji',
          id: `custom:${emoji.name}`,
          label: `:${emoji.name}:`,
          ...(emoji.url ? { iconUrl: emoji.url } : {}),
          ...(emoji.aliasFor ? { hint: `alias for :${emoji.aliasFor}:` } : {}),
          insert: `:${emoji.name}:`,
        });
      }
    }
    for (const emoji of UNICODE_EMOJI) {
      const score = scoreMatch(emoji.name, term);
      if (score > 0) {
        out.push({
          score,
          kind: 'emoji',
          id: `unicode:${emoji.char}`,
          label: emoji.char,
          icon: emoji.char,
          insert: emoji.char,
        });
      }
    }
  }

  if (query.trigger === '/') {
    for (const command of COMMANDS) {
      const score = scoreMatch(command.name, term);
      if (score > 0) {
        out.push({
          score,
          kind: 'command',
          id: command.name,
          label: `/${command.name}`,
          hint: command.hint,
          insert: `/${command.name}`,
        });
      }
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ score: _score, ...suggestion }) => suggestion);
}
