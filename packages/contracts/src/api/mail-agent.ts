// Shared Superhuman-style mail agent. The Mail UI, `od mail`, and
// `tools mail` all classify, summarize, and draft from these helpers so a
// message that looks like "needs a reply" in the split inbox is the same
// message the agent stars when it sorts the mailbox.
//
// This is extractive on purpose: it has to be instant and run without a
// model call. Gmail stays the source of truth; these functions never invent
// labels that Gmail does not already understand.

import type { MailMessage } from './mail.js';

export const MAIL_TRIAGE_BUCKETS = ['needs_reply', 'fyi', 'bulk', 'other'] as const;

export type MailTriageBucket = (typeof MAIL_TRIAGE_BUCKETS)[number];

export interface MailTriageDecision {
  messageId: string;
  threadId: string;
  bucket: MailTriageBucket;
  reason: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

export interface MailTriageRequest {
  apply?: boolean;
  maxResults?: number;
  label?: string;
  query?: string;
}

export interface MailTriageResponse {
  connected: boolean;
  applied: boolean;
  decisions: MailTriageDecision[];
  appliedCount: number;
}

export interface MailSummary {
  headline: string;
  bullets: string[];
  bucket: MailTriageBucket;
  latestFrom: string;
}

export interface MailDraft {
  to: string[];
  body: string;
  reason: string;
}

export interface MailDraftRequest {
  instruction?: string;
}

const BULK_FROM =
  /(?:no-?reply|do-?not-?reply|notifications?|mailer-daemon|newsletter|news@|updates?@|digest@|billing@|invoice@|support@|alert@|bounces@)/i;

const BULK_CORPUS =
  /\bunsubscribe\b|\bview in browser\b|\bemail preferences\b|\bthis is an automated\b|\bmailing list\b|\bweekly digest\b|\bverify your email\b|\bpassword reset\b|\breceipt for\b|\binvoice\s*#/i;

const ASK_CORPUS =
  /\?|\bplease\b|\bcan you\b|\bcould you\b|\bwould you\b|\blet me know\b|\bwaiting on\b|\bneed you\b|\baction required\b|\brsvp\b|\beod\b|\basap\b|\bconfirm\b|\breview\b|\bsign off\b/;

const FYI_CORPUS =
  /\bfyi\b|\bfor your information\b|\bno action\b|\bno need to reply\b|\bnntr\b|\bfyig\b|\bccing you\b/;

const GMAIL_BULK_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);

function corpusOf(message: MailMessage): string {
  return `${message.subject}\n${message.snippet}\n${message.from}\n${message.text ?? ''}`.toLowerCase();
}

function uniqueLabels(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function hasLabel(message: MailMessage, id: string): boolean {
  return message.labelIds.includes(id);
}

export function senderDisplayName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match?.[1]) return match[1].trim();
  const local = from.split('@')[0]?.trim();
  return local || from;
}

export function senderFirstName(from: string): string {
  const name = senderDisplayName(from);
  const first = name.split(/\s+/)[0]?.replace(/[,.]$/, '') ?? '';
  if (!first || BULK_FROM.test(first) || /@/.test(first)) return '';
  return first;
}

function looksBulk(message: MailMessage, corpus: string): boolean {
  if (message.starred) return false;
  if (message.labelIds.some((id) => GMAIL_BULK_LABELS.has(id))) return true;
  if (BULK_FROM.test(message.from)) return true;
  return BULK_CORPUS.test(corpus);
}

function looksLikeAsk(corpus: string): boolean {
  return ASK_CORPUS.test(corpus);
}

function looksLikeFyi(corpus: string): boolean {
  return FYI_CORPUS.test(corpus);
}

/**
 * Decide how a message should be sorted and marked. Label mutations are
 * described, not applied — the daemon writes them to Gmail only when the
 * caller asks to apply triage.
 */
export function classifyMailMessage(message: MailMessage): MailTriageDecision {
  const corpus = corpusOf(message);
  const add: string[] = [];
  const remove: string[] = [];

  if (looksBulk(message, corpus)) {
    if (hasLabel(message, 'INBOX')) remove.push('INBOX');
    if (message.unread) remove.push('UNREAD');
    return {
      messageId: message.id,
      threadId: message.threadId,
      bucket: 'bulk',
      reason: 'Automated or promotional mail — archive and mark read.',
      addLabelIds: uniqueLabels(add),
      removeLabelIds: uniqueLabels(remove),
    };
  }

  if (looksLikeFyi(corpus) && !looksLikeAsk(corpus)) {
    if (message.unread) remove.push('UNREAD');
    return {
      messageId: message.id,
      threadId: message.threadId,
      bucket: 'fyi',
      reason: 'No reply needed — mark read and leave in the inbox.',
      addLabelIds: uniqueLabels(add),
      removeLabelIds: uniqueLabels(remove),
    };
  }

  if (looksLikeAsk(corpus) || (message.unread && hasLabel(message, 'IMPORTANT'))) {
    if (!message.starred) add.push('STARRED');
    if (!hasLabel(message, 'IMPORTANT')) add.push('IMPORTANT');
    return {
      messageId: message.id,
      threadId: message.threadId,
      bucket: 'needs_reply',
      reason: 'Someone is waiting — star and mark important.',
      addLabelIds: uniqueLabels(add),
      removeLabelIds: uniqueLabels(remove),
    };
  }

  return {
    messageId: message.id,
    threadId: message.threadId,
    bucket: 'other',
    reason: 'Keep in the inbox; no automatic marks.',
    addLabelIds: [],
    removeLabelIds: [],
  };
}

export function classifyMailMessages(messages: readonly MailMessage[]): MailTriageDecision[] {
  return messages.map(classifyMailMessage);
}

function sentencesFrom(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
    const sentence = part.trim();
    if (sentence.length < 24 || sentence.length > 220) continue;
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sentence);
    if (out.length >= 4) break;
  }
  return out;
}

export function summarizeMailThread(messages: readonly MailMessage[]): MailSummary {
  const latest = messages[messages.length - 1] ?? null;
  const first = messages[0] ?? latest;
  if (!latest || !first) {
    return { headline: 'Empty thread', bullets: [], bucket: 'other', latestFrom: '' };
  }
  const decision = classifyMailMessage(latest);
  const body = (latest.text || latest.snippet || '').trim();
  const bullets = sentencesFrom(body);
  if (bullets.length === 0 && latest.snippet) bullets.push(latest.snippet.trim());
  const who = senderDisplayName(latest.from);
  const subject = first.subject.replace(/^(re|fwd):\s*/i, '').trim() || 'Untitled';
  return {
    headline: `${who} · ${subject}`,
    bullets,
    bucket: decision.bucket,
    latestFrom: latest.from,
  };
}

function defaultDraftBody(latest: MailMessage, instruction: string | undefined): { body: string; reason: string } {
  const first = senderFirstName(latest.from);
  const hi = first ? `Hi ${first},` : 'Hi,';
  const topic = latest.subject.replace(/^(re|fwd):\s*/i, '').trim() || 'this';
  if (instruction?.trim()) {
    return {
      body: `${hi}\n\n${instruction.trim()}\n`,
      reason: 'Drafted from your instruction.',
    };
  }
  if (looksLikeAsk(corpusOf(latest))) {
    return {
      body: `${hi}\n\nThanks — I'll look at ${topic} and get back to you shortly.\n`,
      reason: 'They asked for something; this is a fast, editable reply.',
    };
  }
  return {
    body: `${hi}\n\nThanks for sending this. I'll review ${topic} and follow up.\n`,
    reason: 'A short acknowledgement you can send or edit.',
  };
}

export function draftMailReply(
  messages: readonly MailMessage[],
  options?: MailDraftRequest,
): MailDraft {
  const latest = messages[messages.length - 1];
  if (!latest) {
    return { to: [], body: '', reason: 'No messages in this thread.' };
  }
  const to = latest.from.includes('@') ? [latest.from] : [];
  const drafted = defaultDraftBody(latest, options?.instruction);
  return { to, ...drafted };
}

export function mailTriageHasWork(decision: MailTriageDecision): boolean {
  return decision.addLabelIds.length > 0 || decision.removeLabelIds.length > 0;
}
