// Live Gmail through Composio. Mail stays in Gmail — we never copy a mailbox
// into the org database. Parsing is defensive because Composio wraps Gmail
// payloads in a few different envelopes depending on the tool and version.

import type {
  MailAttachment,
  MailLabel,
  MailMessage,
  MailProfile,
  ModifyMailRequest,
  ReplyMailRequest,
  SendMailRequest,
  SendMailResponse,
} from '@open-design/contracts';
import type { BoundedJsonObject } from '../live-artifacts/schema.js';
import { composioConnectorProvider } from '../connectors/composio.js';
import type { ConnectorCredentialMaterial } from '../connectors/service.js';
import { WorkspaceDataError } from './errors.js';

export const GMAIL_CONNECTOR_ID = 'gmail';

export interface MailListQuery {
  labelIds?: string[];
  query?: string;
  pageToken?: string;
  maxResults?: number;
  includePayload?: boolean;
}

export interface GmailExecutor {
  execute(toolName: string, input: Record<string, unknown>, sideEffect: 'read' | 'write'): Promise<unknown>;
}

function gmailTool(name: string, sideEffect: 'read' | 'write') {
  return {
    name,
    providerToolId: name,
    description: name,
    inputSchema: { type: 'object' },
    safety: {
      sideEffect,
      approval: sideEffect === 'read' ? 'auto' : 'confirm',
      reason: 'gmail',
    },
  } as never;
}

export function createGmailExecutor(
  credentials: ConnectorCredentialMaterial | undefined,
): GmailExecutor {
  return {
    async execute(toolName, input, sideEffect) {
      return composioConnectorProvider.execute(
        { id: GMAIL_CONNECTOR_ID } as never,
        gmailTool(toolName, sideEffect),
        input as BoundedJsonObject,
        credentials,
      );
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function unwrapData(value: unknown): unknown {
  let current = parseMaybeJson(value);
  for (let i = 0; i < 4; i += 1) {
    const rec = asRecord(current);
    if (!rec) return current;
    const nested = rec.data ?? rec.response_data ?? rec.response ?? rec.result;
    if (nested === undefined) return current;
    current = parseMaybeJson(nested);
  }
  return current;
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function numberField(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      const rec = asRecord(item);
      if (!rec) return '';
      return stringField(rec, 'email', 'address', 'value') ?? '';
    })
    .filter(Boolean);
}

function maybeDecodeBody(value: string): string {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value) || value.length < 4) return value;
  const decoded = decodeBase64Url(value);
  if (!decoded) return value;
  const printable = decoded.replace(/[\t\n\r]/g, '');
  if (printable.length === 0) return value;
  let ok = 0;
  for (const ch of printable) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) ok += 1;
  }
  return ok / printable.length > 0.85 ? decoded : value;
}

function decodeBase64Url(value: string): string | null {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  try {
    return Buffer.from(padded + pad, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function collectPayloadParts(value: unknown, into: Record<string, unknown>[]): void {
  const rec = asRecord(value);
  if (!rec) return;
  into.push(rec);
  const parts = rec.parts ?? rec.payload;
  if (Array.isArray(parts)) {
    for (const part of parts) collectPayloadParts(part, into);
  } else if (parts && parts !== rec.payload) {
    collectPayloadParts(parts, into);
  }
}

function payloadBodies(rec: Record<string, unknown>): { text: string | null; html: string | null } {
  const parts: Record<string, unknown>[] = [];
  collectPayloadParts(rec.payload ?? rec, parts);
  let text: string | null = null;
  let html: string | null = null;
  for (const part of parts) {
    const mime = (stringField(part, 'mimeType', 'mime_type', 'mimetype') ?? '').toLowerCase();
    const nestedBody = asRecord(part.body);
    const data = stringField(part, 'data') ?? (nestedBody ? stringField(nestedBody, 'data') : null);
    if (!data) continue;
    const decoded = maybeDecodeBody(data);
    if (mime.includes('text/html') && !html) html = decoded;
    else if (mime.includes('text/plain') && !text) text = decoded;
  }
  return { text, html };
}

function headerMap(rec: Record<string, unknown>): Record<string, string> {
  const headers = rec.headers ?? rec.payloadHeaders ?? asRecord(rec.payload)?.headers;
  const out: Record<string, string> = {};
  if (!Array.isArray(headers)) return out;
  for (const item of headers) {
    const header = asRecord(item);
    if (!header) continue;
    const name = stringField(header, 'name', 'key');
    const value = stringField(header, 'value');
    if (name && value) out[name.toLowerCase()] = value;
  }
  return out;
}

function attachmentsFrom(rec: Record<string, unknown>): MailAttachment[] {
  const raw = rec.attachments ?? rec.attachmentList ?? rec.files;
  if (!Array.isArray(raw)) return [];
  const out: MailAttachment[] = [];
  for (const item of raw) {
    const att = asRecord(item);
    if (!att) continue;
    const filename = stringField(att, 'filename', 'name', 'fileName') ?? 'attachment';
    out.push({
      filename,
      mimeType: stringField(att, 'mimeType', 'mime_type', 'mimetype') ?? 'application/octet-stream',
      size: numberField(att, 'size', 'bytes'),
      attachmentId: stringField(att, 'attachmentId', 'attachment_id', 'id'),
    });
  }
  return out;
}

export function extractMailMessages(payload: unknown): MailMessage[] {
  const root = unwrapData(payload);
  const rec = asRecord(root);
  const candidates: unknown[] = [];
  if (Array.isArray(root)) candidates.push(...root);
  if (rec) {
    const nested =
      rec.messages
      ?? rec.emails
      ?? rec.items
      ?? rec.threads
      ?? rec.message_list;
    if (Array.isArray(nested)) candidates.push(...nested);
  }
  const out: MailMessage[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const message = normalizeMailMessage(raw);
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(message);
  }
  out.sort((a, b) => (b.internalDate ?? 0) - (a.internalDate ?? 0));
  return out;
}

export function extractNextPageToken(payload: unknown): string | null {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload);
  if (!rec) return null;
  return stringField(rec, 'nextPageToken', 'next_page_token', 'pageToken');
}

export function extractResultSize(payload: unknown): number | null {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload);
  if (!rec) return null;
  return numberField(rec, 'resultSizeEstimate', 'result_size_estimate', 'resultSize');
}

export function extractMailLabels(payload: unknown): MailLabel[] {
  const root = unwrapData(payload);
  const rec = asRecord(root);
  const list = Array.isArray(root)
    ? root
    : Array.isArray(rec?.labels)
      ? rec.labels
      : [];
  const out: MailLabel[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = stringField(item, 'id', 'labelId', 'label_id');
    const name = stringField(item, 'name', 'label', 'displayName') ?? id;
    if (!id || !name) continue;
    const typeRaw = (stringField(item, 'type') ?? 'user').toLowerCase();
    out.push({
      id,
      name,
      type: typeRaw === 'system' ? 'system' : 'user',
      messagesUnread: numberField(item, 'messagesUnread', 'messages_unread', 'unread'),
      messagesTotal: numberField(item, 'messagesTotal', 'messages_total'),
    });
  }
  return out;
}

export function extractMailProfile(payload: unknown): MailProfile | null {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload);
  if (!rec) return null;
  const emailAddress = stringField(
    rec,
    'emailAddress',
    'email_address',
    'email',
    'address',
  );
  if (!emailAddress && numberField(rec, 'messagesTotal') === null) return null;
  return {
    emailAddress,
    messagesTotal: numberField(rec, 'messagesTotal', 'messages_total'),
    threadsTotal: numberField(rec, 'threadsTotal', 'threads_total'),
  };
}

export function extractSendResult(payload: unknown): SendMailResponse {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload) ?? {};
  return {
    id: stringField(rec, 'id', 'messageId', 'message_id'),
    threadId: stringField(rec, 'threadId', 'thread_id'),
  };
}

export function normalizeMailMessage(value: unknown): MailMessage | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const nestedMessage = asRecord(rec.message);
  const source = nestedMessage ?? rec;
  const id =
    stringField(source, 'id', 'messageId', 'message_id')
    ?? stringField(rec, 'id', 'messageId', 'message_id');
  if (!id) return null;
  const headers = headerMap(source);
  const bodies = payloadBodies(source);
  const labelIds = stringArray(source.labelIds ?? source.label_ids ?? rec.labelIds);
  const internalDateRaw = numberField(source, 'internalDate', 'internal_date')
    ?? numberField(rec, 'internalDate', 'internal_date');
  const internalDate = internalDateRaw && internalDateRaw < 1e12
    ? internalDateRaw * 1000
    : internalDateRaw;
  const from =
    stringField(source, 'from', 'sender', 'fromEmail', 'from_email')
    ?? headers.from
    ?? '';
  const to = stringArray(source.to ?? source.recipient ?? source.recipients ?? headers.to);
  const cc = stringArray(source.cc ?? headers.cc);
  const date = stringField(source, 'date', 'timestamp') ?? headers.date ?? null;
  const text =
    stringField(source, 'messageText', 'message_text', 'textPlain', 'text', 'bodyPreview', 'preview')
    ?? bodies.text;
  const html =
    stringField(source, 'messageHtml', 'message_html', 'textHtml', 'html', 'bodyHtml')
    ?? bodies.html;
  return {
    id,
    threadId: stringField(source, 'threadId', 'thread_id') ?? id,
    subject: stringField(source, 'subject') ?? headers.subject ?? '(no subject)',
    snippet: stringField(source, 'snippet', 'preview', 'bodyPreview') ?? (text ? text.slice(0, 160) : ''),
    from,
    to,
    cc,
    date: date ?? null,
    internalDate,
    labelIds,
    unread: labelIds.includes('UNREAD'),
    starred: labelIds.includes('STARRED'),
    text,
    html,
    attachments: attachmentsFrom(source),
  };
}

function gmailFailure(err: unknown, fallback: string): never {
  const message = err instanceof Error ? err.message : fallback;
  throw new WorkspaceDataError('CONNECTOR_EXECUTION_FAILED', 502, message);
}

export async function fetchMailProfile(exec: GmailExecutor): Promise<MailProfile | null> {
  try {
    return extractMailProfile(await exec.execute('GMAIL_GET_PROFILE', { user_id: 'me' }, 'read'));
  } catch {
    return null;
  }
}

export async function listMailLabels(exec: GmailExecutor): Promise<MailLabel[]> {
  try {
    return extractMailLabels(await exec.execute('GMAIL_LIST_LABELS', {
      user_id: 'me',
      include_details: true,
    }, 'read'));
  } catch (err) {
    gmailFailure(err, 'Could not list Gmail labels');
  }
}

export async function listMailMessages(
  exec: GmailExecutor,
  query: MailListQuery,
): Promise<{ messages: MailMessage[]; nextPageToken: string | null; resultSizeEstimate: number | null }> {
  const maxResults = Math.min(Math.max(query.maxResults ?? 40, 1), 100);
  const input: Record<string, unknown> = {
    user_id: 'me',
    max_results: maxResults,
    verbose: false,
    include_payload: query.includePayload === true,
    include_spam_trash: (query.labelIds ?? []).some((id) => id === 'SPAM' || id === 'TRASH'),
  };
  if (query.query) input.query = query.query;
  if (query.labelIds && query.labelIds.length > 0) input.label_ids = query.labelIds;
  if (query.pageToken) input.page_token = query.pageToken;
  try {
    const payload = await exec.execute('GMAIL_FETCH_EMAILS', input, 'read');
    return {
      messages: extractMailMessages(payload),
      nextPageToken: extractNextPageToken(payload),
      resultSizeEstimate: extractResultSize(payload),
    };
  } catch (err) {
    gmailFailure(err, 'Could not list Gmail messages');
  }
}

export async function getMailThread(exec: GmailExecutor, threadId: string): Promise<MailMessage[]> {
  try {
    const payload = await exec.execute('GMAIL_FETCH_MESSAGE_BY_THREAD_ID', {
      user_id: 'me',
      thread_id: threadId,
    }, 'read');
    const messages = extractMailMessages(payload);
    messages.sort((a, b) => (a.internalDate ?? 0) - (b.internalDate ?? 0));
    return messages;
  } catch (err) {
    gmailFailure(err, 'Could not load Gmail thread');
  }
}

export async function sendMail(exec: GmailExecutor, input: SendMailRequest): Promise<SendMailResponse> {
  const to = input.to.filter(Boolean);
  if (to.length === 0) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'at least one recipient is required');
  }
  if (!input.subject.trim() && !input.body.trim()) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'subject or body is required');
  }
  try {
    const payload = await exec.execute('GMAIL_SEND_EMAIL', {
      user_id: 'me',
      recipient_email: to[0],
      extra_recipients: to.slice(1),
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      body: input.body,
      is_html: Boolean(input.isHtml),
    }, 'write');
    return extractSendResult(payload);
  } catch (err) {
    gmailFailure(err, 'Could not send Gmail message');
  }
}

export async function replyToThread(
  exec: GmailExecutor,
  threadId: string,
  input: ReplyMailRequest,
): Promise<SendMailResponse> {
  const to = input.to.filter(Boolean);
  if (to.length === 0) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'at least one recipient is required');
  }
  try {
    const payload = await exec.execute('GMAIL_REPLY_TO_THREAD', {
      user_id: 'me',
      thread_id: threadId,
      recipient_email: to[0],
      extra_recipients: to.slice(1),
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      message_body: input.body,
      is_html: Boolean(input.isHtml),
    }, 'write');
    return extractSendResult(payload);
  } catch (err) {
    gmailFailure(err, 'Could not send Gmail reply');
  }
}

export async function modifyMailMessage(
  exec: GmailExecutor,
  messageId: string,
  input: ModifyMailRequest,
): Promise<void> {
  const add = input.addLabelIds ?? [];
  const remove = input.removeLabelIds ?? [];
  if (add.length === 0 && remove.length === 0) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'addLabelIds or removeLabelIds is required');
  }
  try {
    await exec.execute('GMAIL_ADD_LABEL_TO_EMAIL', {
      user_id: 'me',
      message_id: messageId,
      add_label_ids: add,
      remove_label_ids: remove,
    }, 'write');
  } catch (err) {
    gmailFailure(err, 'Could not update Gmail labels');
  }
}

export async function trashMailMessage(exec: GmailExecutor, messageId: string): Promise<void> {
  try {
    await exec.execute('GMAIL_MOVE_TO_TRASH', {
      user_id: 'me',
      message_id: messageId,
    }, 'write');
  } catch (err) {
    gmailFailure(err, 'Could not move Gmail message to trash');
  }
}

export function parseAddressList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => parseAddressList(item));
  if (typeof value !== 'string') return [];
  return value.split(/[,;]/).map((part) => part.trim()).filter((part) => part.includes('@'));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Body of an organization invite sent through the connected Gmail account. */
export function composeOrgInviteEmail(input: {
  orgName: string;
  role: string;
  url: string;
}): { subject: string; body: string; isHtml: true } {
  const name = escapeHtml(input.orgName);
  const role = escapeHtml(input.role);
  const url = escapeHtml(input.url);
  return {
    subject: `You're invited to ${input.orgName}`,
    isHtml: true,
    body: [
      `<p>You've been invited to join <strong>${name}</strong> as ${role}.</p>`,
      `<p><a href="${url}">Join ${name}</a></p>`,
      `<p>If the button does not work, paste this link into your browser:<br>${url}</p>`,
    ].join(''),
  };
}
