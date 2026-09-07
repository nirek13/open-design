import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../src/api/mail.js';
import {
  classifyMailMessage,
  classifyMailMessages,
  draftMailReply,
  extractMailAddress,
  extractMailAddresses,
  mailTriageHasWork,
  senderFirstName,
  summarizeMailThread,
} from '../src/api/mail-agent.js';

function message(partial: Partial<MailMessage>): MailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    subject: 'Hello',
    snippet: 'Just saying hi.',
    from: 'Ada <ada@example.com>',
    to: ['you@example.com'],
    cc: [],
    date: null,
    internalDate: 1,
    labelIds: ['INBOX', 'UNREAD'],
    unread: true,
    starred: false,
    text: 'Just saying hi.',
    html: null,
    attachments: [],
    ...partial,
  };
}

describe('mail agent', () => {
  it('stars and marks important mail that asks for a review', () => {
    const decision = classifyMailMessage(message({
      subject: 'Q3 budget',
      snippet: 'Please review the attached budget.',
      text: 'Please review the attached budget and confirm by EOD.',
    }));
    expect(decision.bucket).toBe('needs_reply');
    expect(decision.addLabelIds).toEqual(['STARRED', 'IMPORTANT']);
    expect(mailTriageHasWork(decision)).toBe(true);
  });

  it('archives promotional bulk and leaves starred newsletters alone', () => {
    const bulk = classifyMailMessage(message({
      from: 'Deals <noreply@shop.example>',
      subject: 'Weekly digest',
      snippet: 'Unsubscribe at any time.',
      labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    }));
    expect(bulk.bucket).toBe('bulk');
    expect(bulk.removeLabelIds).toEqual(['INBOX', 'UNREAD']);

    const kept = classifyMailMessage(message({
      from: 'Deals <noreply@shop.example>',
      snippet: 'Unsubscribe at any time.',
      starred: true,
      labelIds: ['INBOX', 'STARRED', 'CATEGORY_PROMOTIONS'],
    }));
    expect(kept.bucket).not.toBe('bulk');
  });

  it('marks FYI threads read without archiving them', () => {
    const decision = classifyMailMessage(message({
      subject: 'FYI: office closed Friday',
      snippet: 'No action needed — for your information only.',
      text: 'FYI, the office is closed. No need to reply.',
    }));
    expect(decision.bucket).toBe('fyi');
    expect(decision.removeLabelIds).toEqual(['UNREAD']);
    expect(decision.addLabelIds).toEqual([]);
  });

  it('summarizes a thread into a headline and bullets', () => {
    const summary = summarizeMailThread([
      message({
        subject: 'Q3 budget',
        from: 'Ada Lovelace <ada@example.com>',
        text: 'Please review the attached budget. We need a decision before Friday. Accounting already signed off.',
      }),
    ]);
    expect(summary.headline).toContain('Ada Lovelace');
    expect(summary.headline).toContain('Q3 budget');
    expect(summary.bucket).toBe('needs_reply');
    expect(summary.bullets.length).toBeGreaterThan(0);
  });

  it('does not repeat the same sentence in summary bullets', () => {
    const repeated = 'This email summarises the info that you shared.';
    const summary = summarizeMailThread([
      message({
        text: `${repeated} ${repeated} Please review the attached budget before Friday.`,
      }),
    ]);
    expect(summary.bullets.filter((bullet) => bullet === repeated)).toHaveLength(1);
    expect(summary.bullets).toContain('Please review the attached budget before Friday.');
  });

  it('extracts a bare address from display-name mail headers', () => {
    expect(extractMailAddress('Ada <ada@example.com>')).toBe('ada@example.com');
    expect(extractMailAddress('"Ada Lovelace" <ada@example.com>')).toBe('ada@example.com');
    expect(extractMailAddress('pat@example.com')).toBe('pat@example.com');
    expect(extractMailAddress('not-an-address')).toBeNull();
    expect(extractMailAddresses('Ada <ada@example.com>, bob@example.com, ada@example.com')).toEqual([
      'ada@example.com',
      'bob@example.com',
    ]);
  });

  it('drafts a reply to the latest sender, honoring an instruction', () => {
    const thread = [message({ subject: 'Q3 budget', from: 'Ada <ada@example.com>' })];
    const auto = draftMailReply(thread);
    expect(auto.to).toEqual(['ada@example.com']);
    expect(auto.body).toMatch(/^Hi Ada,/);
    expect(auto.body).toContain('Q3 budget');

    const steered = draftMailReply(thread, { instruction: 'Yes — approved, ship it.' });
    expect(steered.body).toBe('Hi Ada,\n\nYes — approved, ship it.\n');
    expect(senderFirstName('Ada Lovelace <ada@example.com>')).toBe('Ada');
  });

  it('classifies a batch without dropping ids', () => {
    const decisions = classifyMailMessages([
      message({ id: 'a' }),
      message({ id: 'b', snippet: 'Please confirm the time?' }),
    ]);
    expect(decisions.map((item) => item.messageId)).toEqual(['a', 'b']);
    expect(decisions[1]?.bucket).toBe('needs_reply');
  });
});
