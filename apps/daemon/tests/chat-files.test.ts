import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chatFileContentDisposition,
  readChatFile,
  sniffChatFileMime,
  writeChatFile,
} from '../src/workspace-data/chat-files.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('chat-files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('stores a file under the data root and returns a safe attachment', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-chat-files-'));
    dirs.push(dataDir);
    const attachment = await writeChatFile(dataDir, 'ws-1', PNG, 'logo.png', 'image/png');
    expect(attachment.kind).toBe('file');
    expect(attachment.fileName).toBe('logo.png');
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.url).toMatch(/^\/api\/orgs\/ws-1\/chat\/files\/file-/);

    const stored = await readChatFile(dataDir, 'ws-1', attachment.id);
    expect(stored?.bytes.equals(PNG)).toBe(true);
  });

  it('sniffs images from bytes and forces download for html', () => {
    expect(sniffChatFileMime(PNG, 'x.bin')).toBe('image/png');
    expect(sniffChatFileMime(Buffer.from('not-magic'), 'notes.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(sniffChatFileMime(Buffer.from('not-magic'), 'pack.zip')).toBe('application/zip');
    expect(sniffChatFileMime(Buffer.from('not-magic'), 'invite.ics')).toBe('text/calendar');
    expect(sniffChatFileMime(Buffer.from('not-magic'), 'clip.mkv')).toBe('video/x-matroska');
    expect(chatFileContentDisposition('text/html', 'note.html')).toContain('attachment');
    expect(chatFileContentDisposition('image/png', 'logo.png')).toContain('inline');
  });
});
