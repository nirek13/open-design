import { describe, expect, it } from 'vitest';
import {
  chatFileKind,
  extractMessageUrls,
  filesFromTransfer,
  parseChatAccent,
  parseChatCsv,
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
    expect(chatFileKind('image/heic', 'photo.heic')).toBe('file');
    expect(chatFileKind('video/x-matroska', 'clip.mkv')).toBe('video');
    expect(chatFileKind('text/markdown', 'notes.md')).toBe('markdown');
    expect(chatFileKind('', 'notes.md')).toBe('markdown');
    expect(chatFileKind('text/csv', 'grid.csv')).toBe('csv');
    expect(chatFileKind('application/json', 'data.json')).toBe('json');
    expect(chatFileKind('text/html', 'card.html')).toBe('html');
    expect(chatFileKind('', 'util.ts')).toBe('code');
    expect(chatFileKind('text/plain', 'readme.txt')).toBe('text');
    expect(chatFileKind('font/ttf', 'brand.ttf')).toBe('font');
    expect(chatFileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'notes.docx')).toBe('file');
  });

  it('collects files from a paste or drop DataTransfer', () => {
    const zip = new File(['pk'], 'pack.zip', { type: 'application/zip' });
    const transfer = {
      files: [zip],
      items: [],
    } as unknown as DataTransfer;
    expect(filesFromTransfer(transfer).map((file) => file.name)).toEqual(['pack.zip']);

    const shot = new File(['img'], 'shot.png', { type: 'image/png' });
    const paste = {
      files: [],
      items: [{ kind: 'file', getAsFile: () => shot }],
    } as unknown as DataTransfer;
    expect(filesFromTransfer(paste).map((file) => file.name)).toEqual(['shot.png']);
    expect(filesFromTransfer(null)).toEqual([]);
  });

  it('splits csv rows for the table preview', () => {
    expect(parseChatCsv('name,role\nAda,"Lead, design"')).toEqual([
      ['name', 'role'],
      ['Ada', 'Lead, design'],
    ]);
  });

  it('pulls a chat accent from design-system tokens and swatches', () => {
    const accent = parseChatAccent(':root { --color-primary: #0b6e4f; }', ['#0b6e4f', '#f4e8c1']);
    expect(accent?.accent).toBe('#0b6e4f');
    expect(accent?.sidebar.startsWith('#')).toBe(true);
    expect(accent?.onAccent).toBe('#ffffff');
  });
});
