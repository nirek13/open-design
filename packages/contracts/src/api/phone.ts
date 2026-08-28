/** Phone inbox — Slack and iMessage as inbound channels into Open Design. */

import type { SlackChannel } from './slack.js';

export type PhoneChannelKind = 'slack' | 'imessage';
export type PhoneChannelStatus = 'pairing' | 'active' | 'paused';

export interface PhoneChannel {
  id: string;
  kind: PhoneChannelKind;
  label: string;
  status: PhoneChannelStatus;
  pairingCode: string | null;
  inboundUrl: string;
  slackChannelId: string | null;
  slackChannelName: string | null;
  replyUrl: string | null;
  boundFrom: string | null;
  projectId: string | null;
  conversationId: string | null;
  lastInboundAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** Create/rotate responses include the inbound secret exactly once. */
export interface PhoneChannelSecret extends PhoneChannel {
  inboundToken: string;
}

export interface CreatePhoneChannelRequest {
  kind: PhoneChannelKind;
  label?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  replyUrl?: string;
  replyToken?: string;
}

export interface PatchPhoneChannelRequest {
  status?: Extract<PhoneChannelStatus, 'active' | 'paused'>;
  slackChannelId?: string;
  slackChannelName?: string;
  replyUrl?: string | null;
  replyToken?: string | null;
  label?: string;
}

export interface PhoneChannelsResponse {
  channels: PhoneChannel[];
  slackConnected: boolean;
}

export interface PhoneSlackChannelsResponse {
  connected: boolean;
  channels: SlackChannel[];
}

export interface PhoneInboundResponse {
  ok: true;
  status: 'queued' | 'paired' | 'ignored';
  message?: string;
}
