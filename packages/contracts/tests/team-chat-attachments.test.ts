import { describe, expect, it } from 'vitest';
import { sanitizeTeamChatAttachments } from '../src/api/team-chat.js';

describe('sanitizeTeamChatAttachments', () => {
  it('keeps record and app links that chat already posted', () => {
    expect(
      sanitizeTeamChatAttachments([
        { kind: 'record', id: 'rec-1', tableName: 'invoices', label: 'INV-1042' },
        { kind: 'app', id: 'app-1', label: 'Expense form' },
      ]),
    ).toEqual([
      { kind: 'record', id: 'rec-1', tableName: 'invoices', label: 'INV-1042' },
      { kind: 'app', id: 'app-1', label: 'Expense form' },
    ]);
  });

  it('accepts uploaded files and http links, and drops javascript URLs', () => {
    const kept = sanitizeTeamChatAttachments([
      {
        kind: 'file',
        id: 'file-1',
        label: 'brief.pdf',
        url: '/api/orgs/ws-1/chat/files/file-1',
        mimeType: 'application/pdf',
        fileName: 'brief.pdf',
        byteSize: 1200,
      },
      { kind: 'link', id: 'https://example.com/brand', label: 'Brand', url: 'https://example.com/brand' },
      { kind: 'link', id: 'bad', label: 'xss', url: 'javascript:alert(1)' },
      { kind: 'mystery', id: 'x', label: 'nope' },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.kind).toBe('file');
    expect(kept[1]?.kind).toBe('link');
  });

  it('caps the list so a message cannot become a dump of files', () => {
    const raw = Array.from({ length: 40 }, (_, i) => ({
      kind: 'link',
      id: `https://example.com/${i}`,
      label: String(i),
      url: `https://example.com/${i}`,
    }));
    expect(sanitizeTeamChatAttachments(raw)).toHaveLength(16);
  });
});
