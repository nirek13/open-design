import { describe, expect, it } from 'vitest';
import {
  extractChatMentions,
  parseChatSearchQuery,
  sanitizeTeamChatAttachments,
} from '../src/api/team-chat.js';

describe('sanitizeTeamChatAttachments', () => {
  it('keeps record, app, page, and event links that chat already posted', () => {
    expect(
      sanitizeTeamChatAttachments([
        { kind: 'record', id: 'rec-1', tableName: 'invoices', label: 'INV-1042' },
        { kind: 'app', id: 'app-1', label: 'Expense form' },
        { kind: 'page', id: 'page-1', label: 'Handbook' },
        { kind: 'event', id: 'evt-1', label: 'Design review' },
      ]),
    ).toEqual([
      { kind: 'record', id: 'rec-1', tableName: 'invoices', label: 'INV-1042' },
      { kind: 'app', id: 'app-1', label: 'Expense form' },
      { kind: 'page', id: 'page-1', label: 'Handbook' },
      { kind: 'event', id: 'evt-1', label: 'Design review' },
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

describe('chat search and mentions', () => {
  it('parses Slack-style search modifiers', () => {
    const filters = parseChatSearchQuery('invoice in:sales from:ada has:file after:2026-01-01');
    expect(filters.text).toBe('invoice');
    expect(filters.in).toBe('sales');
    expect(filters.from).toBe('ada');
    expect(filters.has).toBe('file');
    expect(filters.after).toBeDefined();
  });

  it('extracts @user and @channel mentions', () => {
    expect(
      extractChatMentions('see @ada and @channel', [
        { id: 'wsm-ada', username: 'ada', displayName: 'Ada' },
      ]),
    ).toEqual(['@channel', 'wsm-ada']);
  });
});
