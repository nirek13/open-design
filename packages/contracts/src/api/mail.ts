/** Live Gmail client — messages stay in Gmail; the daemon is a Composio proxy. */

export interface MailProfile {
  emailAddress: string | null;
  messagesTotal: number | null;
  threadsTotal: number | null;
}

export interface MailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesUnread: number | null;
  messagesTotal: number | null;
}

export interface MailAttachment {
  filename: string;
  mimeType: string;
  size: number | null;
  attachmentId: string | null;
}

export interface MailMessage {
  id: string;
  threadId: string;
  subject: string;
  snippet: string;
  from: string;
  to: string[];
  cc: string[];
  date: string | null;
  internalDate: number | null;
  labelIds: string[];
  unread: boolean;
  starred: boolean;
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
}

export interface MailThread {
  id: string;
  messages: MailMessage[];
}

export interface MailStatusResponse {
  connected: boolean;
  profile: MailProfile | null;
  labels: MailLabel[];
}

export interface MailListResponse {
  connected: boolean;
  profile: MailProfile | null;
  messages: MailMessage[];
  nextPageToken: string | null;
  resultSizeEstimate: number | null;
}

export interface MailThreadResponse {
  thread: MailThread;
}

export interface SendMailRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
}

export interface ReplyMailRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  body: string;
  isHtml?: boolean;
}

export interface ModifyMailRequest {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface SendMailResponse {
  id: string | null;
  threadId: string | null;
}
