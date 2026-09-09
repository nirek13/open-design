import { describe, expect, it } from 'vitest';
import type { ChatCustomEmoji } from '@open-design/contracts';
import { resolveEmojiAlias } from '@open-design/contracts';

import { splitCustomEmoji, type ChatEmojiLookup } from '../../../src/components/team/ChatEmojiContext';

const emoji = (name: string, extra: Partial<ChatCustomEmoji> = {}): ChatCustomEmoji => ({
  name,
  orgId: 'org-1',
  url: null,
  aliasFor: null,
  createdBy: 'wsm-a',
  createdAt: 0,
  ...extra,
});

/** The same lookup the provider builds, without needing to render it. */
function lookupFor(all: ChatCustomEmoji[]): ChatEmojiLookup {
  return {
    all,
    urlFor: (name) => resolveEmojiAlias(name, all)?.url ?? null,
  };
}

describe('splitCustomEmoji', () => {
  const lookup = lookupFor([
    emoji('shipit', { url: '/file-1' }),
    emoji('lgtm', { aliasFor: 'shipit' }),
  ]);

  it('leaves text with no colons untouched, as a single part', () => {
    expect(splitCustomEmoji('hello there', lookup)).toEqual([
      { kind: 'text', value: 'hello there' },
    ]);
  });

  it('swaps a known name for its image and keeps the text around it', () => {
    expect(splitCustomEmoji('ship it :shipit: now', lookup)).toEqual([
      { kind: 'text', value: 'ship it ' },
      { kind: 'emoji', name: 'shipit', url: '/file-1' },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('follows an alias to the image it stands for', () => {
    expect(splitCustomEmoji(':lgtm:', lookup)).toEqual([
      { kind: 'emoji', name: 'lgtm', url: '/file-1' },
    ]);
  });

  it('leaves an unknown name as the text the person typed', () => {
    // `:nope:` is more likely to be prose than a missing emoji, and showing a
    // broken image for it would be worse than showing the words.
    expect(splitCustomEmoji('a :nope: b', lookup)).toEqual([{ kind: 'text', value: 'a :nope: b' }]);
  });

  it('handles two in a row', () => {
    const parts = splitCustomEmoji(':shipit::lgtm:', lookup);
    expect(parts.filter((part) => part.kind === 'emoji')).toHaveLength(2);
  });

  it('is inert when the organization has no custom emoji', () => {
    expect(splitCustomEmoji(':shipit:', lookupFor([]))).toEqual([
      { kind: 'text', value: ':shipit:' },
    ]);
  });
});
