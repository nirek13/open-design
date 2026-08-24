import { describe, expect, it } from 'vitest';
import {
  chatFileKind,
  extractMessageUrls,
  parseChatAccent,
} from '../../src/runtime/chat-media';

describe('chat-media', () => {
  it('extracts unique http links from a message', () => {
    expect(
      extractMessageUrls('See https://example.com/a and https://example.com/a, plus https://youtu.be/x.'),
    ).toEqual(['https://example.com/a', 'https://youtu.be/x']);
  });

  it('maps mime and filename onto a preview kind', () => {
    expect(chatFileKind('image/png', 'shot.png')).toBe('image');
    expect(chatFileKind('video/mp4', 'clip.mp4')).toBe('video');
    expect(chatFileKind('audio/mpeg', 'voicemail.mp3')).toBe('audio');
    expect(chatFileKind('application/pdf', 'brief.pdf')).toBe('pdf');
    expect(chatFileKind('application/zip', 'pack.zip')).toBe('file');
  });

  it('pulls a chat accent from design-system tokens and swatches', () => {
    const accent = parseChatAccent(':root { --color-primary: #0b6e4f; }', ['#0b6e4f', '#f4e8c1']);
    expect(accent?.accent).toBe('#0b6e4f');
    expect(accent?.sidebar.startsWith('#')).toBe(true);
    expect(accent?.onAccent).toBe('#ffffff');
  });
});
