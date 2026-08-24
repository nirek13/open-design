/** Live Slack client — messages stay in Slack; the daemon is a Composio proxy. */

export interface SlackProfile {
  userId: string | null;
  name: string | null;
  team: string | null;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
  memberCount: number | null;
  topic: string | null;
  purpose: string | null;
}

export interface SlackUser {
  id: string;
  name: string;
  realName: string | null;
  displayName: string | null;
  imageUrl: string | null;
  isBot: boolean;
}

export interface SlackReaction {
  name: string;
  count: number;
  me: boolean;
}

export interface SlackMessage {
  ts: string;
  channelId: string;
  userId: string | null;
  userName: string | null;
  text: string;
  threadTs: string | null;
  replyCount: number;
  permalink: string | null;
  reactions: SlackReaction[];
}

export interface SlackStatusResponse {
  connected: boolean;
  profile: SlackProfile | null;
}

export interface SlackChannelsResponse {
  connected: boolean;
  channels: SlackChannel[];
  users: SlackUser[];
}

export interface SlackMessagesResponse {
  connected: boolean;
  channel: SlackChannel | null;
  messages: SlackMessage[];
  cursor: string | null;
}

export interface SlackSearchResponse {
  connected: boolean;
  messages: SlackMessage[];
}

export interface SlackThreadResponse {
  messages: SlackMessage[];
}

export interface SendSlackMessageRequest {
  channelId: string;
  text: string;
  threadTs?: string;
}

export interface SendSlackMessageResponse {
  ts: string | null;
  channelId: string | null;
}

export interface SlackReactRequest {
  channelId: string;
  ts: string;
  emoji: string;
}
