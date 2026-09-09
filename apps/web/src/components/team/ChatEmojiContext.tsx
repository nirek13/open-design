// The organization's custom emoji, made available to anything that renders a
// message body.
//
// A context rather than a prop, because `:shipit:` can appear in a channel
// message, a thread reply, a search hit, a pinned card, a saved item, and a
// reaction — six render paths that would otherwise all have to be handed the
// same list, and one of which would eventually be forgotten and start showing
// people literal colons.
//
// The default is an empty list rather than a thrown error: a message body
// rendered outside a chat view (a notification preview, a test) should show
// `:shipit:` as text, not crash.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { resolveEmojiAlias, type ChatCustomEmoji } from '@open-design/contracts';

export interface ChatEmojiLookup {
  /** The image URL for `:name:`, or null when the organization has no such
   * emoji and the text should stay as it was typed. */
  urlFor(name: string): string | null;
  all: readonly ChatCustomEmoji[];
}

const EMPTY: ChatEmojiLookup = { urlFor: () => null, all: [] };

const ChatEmojiContext = createContext<ChatEmojiLookup>(EMPTY);

export function ChatEmojiProvider({
  emoji,
  children,
}: {
  emoji: readonly ChatCustomEmoji[];
  children: ReactNode;
}) {
  const value = useMemo<ChatEmojiLookup>(() => {
    // One map built per emoji-list change, rather than a linear scan per
    // occurrence. A busy channel renders hundreds of bodies on every update.
    const byName = new Map<string, string>();
    for (const item of emoji) {
      const resolved = resolveEmojiAlias(item.name, emoji);
      if (resolved?.url) byName.set(item.name, resolved.url);
    }
    return {
      all: emoji,
      urlFor: (name) => byName.get(name.replace(/^:+|:+$/g, '').toLowerCase()) ?? null,
    };
  }, [emoji]);
  return <ChatEmojiContext.Provider value={value}>{children}</ChatEmojiContext.Provider>;
}

export function useChatEmoji(): ChatEmojiLookup {
  return useContext(ChatEmojiContext);
}

/** Split a run of text into the parts that are `:custom-emoji:` and the parts
 * that are not. Exported so the message renderer can walk it without knowing
 * the shape of the lookup, and so it can be tested directly. */
export function splitCustomEmoji(
  text: string,
  lookup: ChatEmojiLookup,
): Array<{ kind: 'text'; value: string } | { kind: 'emoji'; name: string; url: string }> {
  if (!text.includes(':')) return [{ kind: 'text', value: text }];
  const out: Array<{ kind: 'text'; value: string } | { kind: 'emoji'; name: string; url: string }> = [];
  const pattern = /:([a-z0-9_+-]{1,32}):/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const url = lookup.urlFor(match[1]!);
    if (!url) continue;
    if (match.index > last) out.push({ kind: 'text', value: text.slice(last, match.index) });
    out.push({ kind: 'emoji', name: match[1]!.toLowerCase(), url });
    last = match.index + match[0].length;
  }
  if (out.length === 0) return [{ kind: 'text', value: text }];
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}
