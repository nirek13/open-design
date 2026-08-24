// Live Slack through Composio. Messages stay in Slack — we never copy a
// workspace into the org database. Parsing is defensive because Composio
// wraps Slack payloads in a few different envelopes depending on the tool.

import type {
  SendSlackMessageRequest,
  SendSlackMessageResponse,
  SlackChannel,
  SlackMessage,
  SlackProfile,
  SlackReaction,
  SlackUser,
} from '@open-design/contracts';
import type { BoundedJsonObject } from '../live-artifacts/schema.js';
import { composioConnectorProvider } from '../connectors/composio.js';
import type { ConnectorCredentialMaterial } from '../connectors/service.js';
import { WorkspaceDataError } from './errors.js';

export const SLACK_CONNECTOR_ID = 'slack';

export interface SlackExecutor {
  execute(toolName: string, input: Record<string, unknown>, sideEffect: 'read' | 'write'): Promise<unknown>;
}

function slackTool(name: string, sideEffect: 'read' | 'write') {
  return {
    name,
    providerToolId: name,
    description: name,
    inputSchema: { type: 'object' },
    safety: {
      sideEffect,
      approval: sideEffect === 'read' ? 'auto' : 'confirm',
      reason: 'slack',
    },
  } as never;
}

export function createSlackExecutor(
  credentials: ConnectorCredentialMaterial | undefined,
): SlackExecutor {
  return {
    async execute(toolName, input, sideEffect) {
      return composioConnectorProvider.execute(
        { id: SLACK_CONNECTOR_ID } as never,
        slackTool(toolName, sideEffect),
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
  for (let i = 0; i < 5; i += 1) {
    const rec = asRecord(current);
    if (!rec) return current;
    const nested =
      rec.data
      ?? rec.response_data
      ?? rec.response
      ?? rec.result
      ?? rec.successful;
    if (nested === undefined || nested === current) return current;
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

function boolField(rec: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = rec[key];
    if (value === true || value === 'true' || value === 1) return true;
  }
  return false;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  if (!rec) return [];
  for (const key of [
    'channels', 'conversations', 'ims', 'members', 'users', 'messages', 'matches',
    'items', 'results',
  ]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  const nestedMessages = asRecord(rec.messages);
  if (nestedMessages && Array.isArray(nestedMessages.matches)) return nestedMessages.matches;
  return [];
}

function slackFailure(err: unknown, fallback: string): never {
  const message = err instanceof Error ? err.message : fallback;
  throw new WorkspaceDataError('CONNECTOR_EXECUTION_FAILED', 502, message);
}

function isMissingTool(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|unknown tool|does not exist|no such tool|404/i.test(message);
}

async function executeFirst(
  exec: SlackExecutor,
  names: string[],
  input: Record<string, unknown>,
  sideEffect: 'read' | 'write',
): Promise<unknown> {
  let last: unknown;
  for (const name of names) {
    try {
      return await exec.execute(name, input, sideEffect);
    } catch (err) {
      last = err;
      if (!isMissingTool(err)) slackFailure(err, `Slack tool ${name} failed`);
    }
  }
  slackFailure(last, `Slack tools unavailable: ${names.join(', ')}`);
}

export function normalizeSlackChannel(value: unknown): SlackChannel | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const id = stringField(rec, 'id', 'channel', 'channel_id', 'conversation_id');
  if (!id) return null;
  const name =
    stringField(rec, 'name', 'channel_name', 'user_name', 'user')
    ?? id;
  return {
    id,
    name: name.replace(/^#/, ''),
    isPrivate: boolField(rec, 'is_private', 'isPrivate', 'private'),
    isIm: boolField(rec, 'is_im', 'isIm', 'is_direct_message', 'isDm'),
    isMpim: boolField(rec, 'is_mpim', 'isMpim', 'is_group'),
    memberCount: numberField(rec, 'num_members', 'member_count', 'members_count'),
    topic: stringField(asRecord(rec.topic) ?? {}, 'value') ?? stringField(rec, 'topic'),
    purpose: stringField(asRecord(rec.purpose) ?? {}, 'value') ?? stringField(rec, 'purpose'),
  };
}

export function extractSlackChannels(payload: unknown): SlackChannel[] {
  const root = unwrapData(payload);
  const out: SlackChannel[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const channel = normalizeSlackChannel(raw);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    out.push(channel);
  }
  out.sort((a, b) => {
    if (a.isIm !== b.isIm) return a.isIm ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export function normalizeSlackUser(value: unknown): SlackUser | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const id = stringField(rec, 'id', 'user_id', 'user');
  if (!id) return null;
  const profile = asRecord(rec.profile) ?? {};
  return {
    id,
    name: stringField(rec, 'name', 'username') ?? id,
    realName: stringField(rec, 'real_name', 'realName') ?? stringField(profile, 'real_name'),
    displayName:
      stringField(profile, 'display_name', 'display_name_normalized')
      ?? stringField(rec, 'display_name'),
    imageUrl:
      stringField(profile, 'image_48', 'image_72', 'image_32', 'image_24')
      ?? stringField(rec, 'image', 'avatar'),
    isBot: boolField(rec, 'is_bot', 'isBot') || boolField(profile, 'always_active') && id.startsWith('B'),
  };
}

export function extractSlackUsers(payload: unknown): SlackUser[] {
  const root = unwrapData(payload);
  const out: SlackUser[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const user = normalizeSlackUser(raw);
    if (!user || seen.has(user.id)) continue;
    seen.add(user.id);
    out.push(user);
  }
  return out;
}

function extractReactions(rec: Record<string, unknown>): SlackReaction[] {
  const raw = rec.reactions;
  if (!Array.isArray(raw)) return [];
  const out: SlackReaction[] = [];
  for (const item of raw) {
    const reaction = asRecord(item);
    if (!reaction) continue;
    const name = stringField(reaction, 'name', 'emoji');
    if (!name) continue;
    out.push({
      name,
      count: numberField(reaction, 'count') ?? 1,
      me: boolField(reaction, 'me'),
    });
  }
  return out;
}

export function normalizeSlackMessage(value: unknown, channelId = ''): SlackMessage | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const nested = asRecord(rec.message) ?? rec;
  const ts = stringField(nested, 'ts', 'timestamp', 'message_ts', 'id');
  if (!ts) return null;
  const text = stringField(nested, 'text', 'message', 'body') ?? '';
  const userRec = asRecord(nested.user) ?? asRecord(nested.user_profile);
  return {
    ts,
    channelId:
      stringField(nested, 'channel', 'channel_id', 'conversation_id')
      ?? channelId,
    userId: stringField(nested, 'user', 'user_id', 'sender') ?? stringField(userRec ?? {}, 'id'),
    userName:
      stringField(nested, 'username', 'user_name', 'sender_name')
      ?? stringField(userRec ?? {}, 'name', 'real_name', 'display_name'),
    text,
    threadTs: stringField(nested, 'thread_ts', 'threadTs', 'thread_timestamp'),
    replyCount: numberField(nested, 'reply_count', 'replyCount', 'replies') ?? 0,
    permalink: stringField(nested, 'permalink', 'link'),
    reactions: extractReactions(nested),
  };
}

export function extractSlackMessages(payload: unknown, channelId = ''): SlackMessage[] {
  const root = unwrapData(payload);
  const rec = asRecord(root);
  const list = asList(root).length > 0
    ? asList(root)
    : rec && Array.isArray(rec.messages)
      ? rec.messages
      : [];
  const out: SlackMessage[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const message = normalizeSlackMessage(raw, channelId);
    if (!message || seen.has(message.ts)) continue;
    seen.add(message.ts);
    out.push(message);
  }
  out.sort((a, b) => Number(a.ts) - Number(b.ts));
  return out;
}

export function extractSlackCursor(payload: unknown): string | null {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload);
  if (!rec) return null;
  const meta = asRecord(rec.response_metadata) ?? asRecord(rec.responseMetadata);
  return (
    stringField(rec, 'cursor', 'next_cursor', 'nextCursor')
    ?? (meta ? stringField(meta, 'next_cursor', 'nextCursor') : null)
  );
}

export function extractSlackProfile(payload: unknown): SlackProfile | null {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload);
  if (!rec) return null;
  const user = asRecord(rec.user) ?? rec;
  const team = asRecord(rec.team) ?? asRecord(user.team) ?? {};
  const userId = stringField(user, 'id', 'user_id', 'user');
  const name =
    stringField(user, 'name', 'real_name', 'display_name')
    ?? stringField(asRecord(user.profile) ?? {}, 'display_name', 'real_name');
  const teamName = stringField(team, 'name', 'team_name') ?? stringField(rec, 'team', 'team_name');
  if (!userId && !name && !teamName) return null;
  return { userId, name, team: teamName };
}

export function extractSendSlackResult(payload: unknown): SendSlackMessageResponse {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload) ?? {};
  const nested = asRecord(rec.message) ?? rec;
  return {
    ts: stringField(nested, 'ts', 'message_ts') ?? stringField(rec, 'ts'),
    channelId: stringField(nested, 'channel', 'channel_id') ?? stringField(rec, 'channel'),
  };
}

const LIST_CHANNEL_TOOLS = [
  'SLACK_LIST_ALL_CHANNELS',
  'SLACK_LIST_CHANNELS',
  'SLACK_LIST_CONVERSATIONS',
];
const LIST_IM_TOOLS = ['SLACK_LIST_CONVERSATIONS', 'SLACK_LIST_ALL_CHANNELS', 'SLACK_LIST_CHANNELS'];
const HISTORY_TOOLS = [
  'SLACK_FETCH_CONVERSATION_HISTORY',
  'SLACK_GET_CHANNEL_HISTORY',
  'SLACK_LIST_MESSAGES',
];
const SEND_TOOLS = ['SLACK_SEND_MESSAGE', 'SLACK_SEND_A_MESSAGE', 'SLACK_POST_MESSAGE'];
const SEARCH_TOOLS = ['SLACK_SEARCH_MESSAGES', 'SLACK_SEARCH_ALL'];
const USER_TOOLS = ['SLACK_LIST_ALL_USERS', 'SLACK_LIST_USERS'];
const PROFILE_TOOLS = ['SLACK_FETCH_TEAM_INFO', 'SLACK_GET_CURRENT_USER', 'SLACK_LIST_ALL_USERS'];
const THREAD_TOOLS = [
  'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
  'SLACK_RETRIEVE_CONVERSATION_REPLIES',
  'SLACK_FETCH_CONVERSATION_REPLIES',
];
const REACT_TOOLS = ['SLACK_ADD_REACTION_TO_AN_ITEM', 'SLACK_ADD_REACTION'];

export async function fetchSlackProfile(exec: SlackExecutor): Promise<SlackProfile | null> {
  try {
    return extractSlackProfile(await executeFirst(exec, PROFILE_TOOLS, {}, 'read'));
  } catch {
    return null;
  }
}

export async function listSlackUsers(exec: SlackExecutor): Promise<SlackUser[]> {
  try {
    return extractSlackUsers(await executeFirst(exec, USER_TOOLS, { limit: 200 }, 'read'));
  } catch {
    return [];
  }
}

export async function listSlackChannels(exec: SlackExecutor): Promise<SlackChannel[]> {
  try {
    const publicChannels = extractSlackChannels(
      await executeFirst(exec, LIST_CHANNEL_TOOLS, {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
      }, 'read'),
    );
    let dms: SlackChannel[] = [];
    try {
      dms = extractSlackChannels(
        await executeFirst(exec, LIST_IM_TOOLS, {
          types: 'im,mpim',
          exclude_archived: true,
          limit: 100,
        }, 'read'),
      );
    } catch {
      dms = [];
    }
    const seen = new Set(publicChannels.map((channel) => channel.id));
    return [...publicChannels, ...dms.filter((channel) => !seen.has(channel.id))];
  } catch (err) {
    slackFailure(err, 'Could not list Slack channels');
  }
}

export async function listSlackMessages(
  exec: SlackExecutor,
  channelId: string,
  options?: { cursor?: string; limit?: number },
): Promise<{ messages: SlackMessage[]; cursor: string | null }> {
  if (!channelId.trim()) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'channelId is required');
  }
  const input: Record<string, unknown> = {
    channel: channelId,
    limit: Math.min(Math.max(options?.limit ?? 50, 1), 200),
  };
  if (options?.cursor) input.cursor = options.cursor;
  try {
    const payload = await executeFirst(exec, HISTORY_TOOLS, input, 'read');
    return {
      messages: extractSlackMessages(payload, channelId),
      cursor: extractSlackCursor(payload),
    };
  } catch (err) {
    slackFailure(err, 'Could not load Slack messages');
  }
}

export async function searchSlackMessages(
  exec: SlackExecutor,
  query: string,
): Promise<SlackMessage[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const payload = await executeFirst(exec, SEARCH_TOOLS, { query: q, count: 30 }, 'read');
    return extractSlackMessages(payload);
  } catch (err) {
    slackFailure(err, 'Could not search Slack');
  }
}

export async function getSlackThread(
  exec: SlackExecutor,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  if (!channelId.trim() || !threadTs.trim()) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'channelId and threadTs are required');
  }
  try {
    const payload = await executeFirst(exec, THREAD_TOOLS, {
      channel: channelId,
      ts: threadTs,
      thread_ts: threadTs,
    }, 'read');
    return extractSlackMessages(payload, channelId);
  } catch (err) {
    slackFailure(err, 'Could not load Slack thread');
  }
}

export async function sendSlackMessage(
  exec: SlackExecutor,
  input: SendSlackMessageRequest,
): Promise<SendSlackMessageResponse> {
  const channelId = input.channelId.trim();
  const text = input.text.trim();
  if (!channelId) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'channelId is required');
  }
  if (!text) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'text is required');
  }
  const payloadInput: Record<string, unknown> = { channel: channelId, text };
  if (input.threadTs?.trim()) payloadInput.thread_ts = input.threadTs.trim();
  try {
    const payload = await executeFirst(exec, SEND_TOOLS, payloadInput, 'write');
    return extractSendSlackResult(payload);
  } catch (err) {
    slackFailure(err, 'Could not send Slack message');
  }
}

export async function reactToSlackMessage(
  exec: SlackExecutor,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const name = emoji.trim().replace(/^:|:$/g, '');
  if (!channelId.trim() || !ts.trim() || !name) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'channelId, ts, and emoji are required');
  }
  try {
    await executeFirst(exec, REACT_TOOLS, {
      channel: channelId,
      timestamp: ts,
      name,
    }, 'write');
  } catch (err) {
    slackFailure(err, 'Could not add Slack reaction');
  }
}
