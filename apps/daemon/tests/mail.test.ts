import { describe, expect, it } from 'vitest';

import {
  composeOrgInviteEmail,
  extractMailLabels,
  extractMailMessages,
  extractMailProfile,
  extractNextPageToken,
  extractSendResult,
  listMailMessages,
  normalizeMailMessage,
  parseAddressList,
  sendMail,
  triageMailMessages,
  type GmailExecutor,
} from '../src/workspace-data/mail.js';

const SAMPLE_MESSAGE = {
  messageId: '18c5f42779f726f2',
  threadId: '18c5f42779f726f0',
  subject: 'Q3 budget',
  sender: 'Ada <ada@example.com>',
  to: 'team@example.com, ops@example.com',
  cc: 'cc@example.com',
  snippet: 'Please review the attached budget.',
  labelIds: ['INBOX', 'UNREAD'],
  internalDate: '1700000000000',
  messageText: 'Please review the attached budget.\nThanks',
};

describe('mail payload parsing', () => {
  it('unwraps Composio envelopes and normalizes a Gmail list item', () => {
    const listed = extractMailMessages({
      toolName: 'GMAIL_FETCH_EMAILS',
      data: { messages: [SAMPLE_MESSAGE], nextPageToken: 'page-2', resultSizeEstimate: 41 },
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: '18c5f42779f726f2',
      threadId: '18c5f42779f726f0',
      subject: 'Q3 budget',
      from: 'Ada <ada@example.com>',
      to: ['team@example.com', 'ops@example.com'],
      unread: true,
      starred: false,
    });
    expect(extractNextPageToken({ data: { nextPageToken: 'page-2' } })).toBe('page-2');
  });

  it('reads Gmail API payload headers and base64 bodies', () => {
    const html = Buffer.from('<p>Hello</p>').toString('base64url');
    const text = Buffer.from('Hello').toString('base64url');
    const message = normalizeMailMessage({
      id: 'abc123',
      threadId: 'thread1',
      labelIds: ['STARRED'],
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello' },
          { name: 'From', value: 'Pat <pat@example.com>' },
          { name: 'To', value: 'you@example.com' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: text } },
          { mimeType: 'text/html', body: { data: html } },
        ],
      },
    });
    expect(message).toMatchObject({
      id: 'abc123',
      subject: 'Hello',
      from: 'Pat <pat@example.com>',
      starred: true,
      unread: false,
      text: 'Hello',
      html: '<p>Hello</p>',
    });
  });

  it('parses labels, profile, send result, and address lists', () => {
    expect(extractMailLabels({
      data: {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 3 },
          { id: 'Label_1', name: 'Work', type: 'user' },
        ],
      },
    })).toEqual([
      { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 3, messagesTotal: null },
      { id: 'Label_1', name: 'Work', type: 'user', messagesUnread: null, messagesTotal: null },
    ]);
    expect(extractMailProfile({ emailAddress: 'ada@example.com', messagesTotal: 12 })).toEqual({
      emailAddress: 'ada@example.com',
      messagesTotal: 12,
      threadsTotal: null,
    });
    expect(extractSendResult({ data: { id: 'm1', threadId: 't1' } })).toEqual({
      id: 'm1',
      threadId: 't1',
    });
    expect(parseAddressList('Ada <ada@example.com>, bob@example.com')).toEqual([
      'ada@example.com',
      'bob@example.com',
    ]);
  });

  it('lists and sends through the Gmail executor contract', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const exec: GmailExecutor = {
      async execute(toolName, input) {
        calls.push({ tool: toolName, input });
        if (toolName === 'GMAIL_FETCH_EMAILS') {
          return { data: { messages: [SAMPLE_MESSAGE] } };
        }
        if (toolName === 'GMAIL_SEND_EMAIL') {
          return { data: { id: 'sent-1', threadId: 'thread-9' } };
        }
        throw new Error(`unexpected ${toolName}`);
      },
    };

    const listed = await listMailMessages(exec, { labelIds: ['INBOX'], maxResults: 25 });
    expect(listed.messages[0]?.subject).toBe('Q3 budget');
    expect(calls[0]).toMatchObject({
      tool: 'GMAIL_FETCH_EMAILS',
      input: { label_ids: ['INBOX'], max_results: 25 },
    });

    const sent = await sendMail(exec, {
      to: ['pat@example.com'],
      subject: 'Hi',
      body: 'Hello',
    });
    expect(sent.id).toBe('sent-1');
    expect(calls[1]?.input).toMatchObject({
      recipient_email: 'pat@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(calls[1]?.input).not.toHaveProperty('extra_recipients');
    expect(calls[1]?.input).not.toHaveProperty('cc');
  });

  it('strips display names before calling Gmail send', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const exec: GmailExecutor = {
      async execute(toolName, input) {
        calls.push({ tool: toolName, input });
        return { data: { id: 'sent-2', threadId: 'thread-2' } };
      },
    };
    await sendMail(exec, {
      to: ['Ada <ada@example.com>', 'bob@example.com'],
      cc: ['Pat <pat@example.com>'],
      subject: 'Hi',
      body: 'Hello',
    });
    expect(calls[0]?.input).toMatchObject({
      recipient_email: 'ada@example.com',
      extra_recipients: ['bob@example.com'],
      cc: ['pat@example.com'],
    });
  });

  it('surfaces the Composio send error instead of a generic failure', async () => {
    const { ConnectorServiceError } = await import('../src/connectors/service.js');
    const exec: GmailExecutor = {
      async execute() {
        throw new ConnectorServiceError('CONNECTOR_EXECUTION_FAILED', 'Composio tool execution failed', 502, {
          error: 'Invalid recipient_email: must be user@domain.com',
        });
      },
    };
    await expect(sendMail(exec, { to: ['pat@example.com'], subject: 'Hi', body: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('Invalid recipient_email'),
    });
  });

  it('refuses a send with no recipients', async () => {
    const exec: GmailExecutor = { execute: async () => ({}) };
    await expect(sendMail(exec, { to: [], subject: 'Hi', body: 'x' })).rejects.toMatchObject({
      code: 'WORKSPACE_VALIDATION_FAILED',
    });
  });

  it('composes an organization invite email', () => {
    const mail = composeOrgInviteEmail({
      orgName: 'Northwind',
      role: 'member',
      url: 'https://example.com/join?token=abc',
    });
    expect(mail.subject).toBe("You're invited to Northwind");
    expect(mail.isHtml).toBe(true);
    expect(mail.body).toContain('<strong>Northwind</strong>');
    expect(mail.body).toContain('https://example.com/join?token=abc');
    expect(mail.body).not.toContain('<script');
  });

  it('applies triage marks through the Gmail executor', async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const exec: GmailExecutor = {
      async execute(toolName, input) {
        calls.push({ tool: toolName, input });
        return {};
      },
    };
    const preview = await triageMailMessages(exec, [normalizeMailMessage(SAMPLE_MESSAGE)], false);
    expect(preview.appliedCount).toBe(0);
    expect(preview.decisions[0]?.bucket).toBe('needs_reply');
    expect(calls).toEqual([]);

    const applied = await triageMailMessages(exec, [normalizeMailMessage(SAMPLE_MESSAGE)], true);
    expect(applied.appliedCount).toBe(1);
    expect(calls[0]).toMatchObject({
      tool: 'GMAIL_ADD_LABEL_TO_EMAIL',
      input: {
        message_id: SAMPLE_MESSAGE.messageId,
        add_label_ids: ['STARRED', 'IMPORTANT'],
      },
    });
  });
});
