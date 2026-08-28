/** Normalize Slack Events, BlueBubbles, Shortcuts, and generic JSON into one inbound. */

export interface ParsedPhoneInbound {
  text: string;
  from: string | null;
  threadTs: string | null;
  echo: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nestedHandle(value: unknown): string | null {
  const rec = asRecord(value);
  if (!rec) return asString(value);
  return asString(rec.address) ?? asString(rec.id) ?? asString(rec.guid);
}

/**
 * Best-effort parse of an inbound webhook body. Unknown shapes with a `text`
 * field still work so an Apple Shortcut can POST `{ text, from }`.
 */
export function parsePhoneInbound(body: unknown): ParsedPhoneInbound | null {
  const rec = asRecord(body);
  if (!rec) {
    if (typeof body === 'string' && body.trim()) {
      return { text: body.trim(), from: null, threadTs: null, echo: false };
    }
    return null;
  }

  const slackEvent = asRecord(rec.event);
  if (slackEvent && (asString(slackEvent.type) === 'message' || asString(slackEvent.text))) {
    const subtype = asString(slackEvent.subtype);
    const text = asString(slackEvent.text) ?? '';
    return {
      text,
      from: asString(slackEvent.user) ?? asString(slackEvent.username),
      threadTs: asString(slackEvent.thread_ts) ?? asString(slackEvent.ts),
      echo: subtype === 'bot_message' || Boolean(slackEvent.bot_id),
    };
  }

  const data = asRecord(rec.data) ?? rec;
  const blueBubblesText = asString(data.text) ?? asString(data.message) ?? asString(rec.text);
  const fromMe = data.isFromMe === true || data.is_from_me === true || rec.isFromMe === true;
  if (blueBubblesText || asString(rec.type) === 'new-message') {
    const handle = nestedHandle(data.handle) ?? nestedHandle(data.chathandle) ?? asString(data.address);
    return {
      text: blueBubblesText ?? '',
      from: handle ?? asString(rec.from) ?? asString(data.guid),
      threadTs: asString(data.guid) ?? asString(data.chatGuid) ?? asString(data.chat_guid),
      echo: fromMe,
    };
  }

  const text = asString(rec.text) ?? asString(rec.message) ?? asString(rec.body);
  if (!text) return null;
  return {
    text,
    from: asString(rec.from) ?? asString(rec.sender) ?? asString(rec.user) ?? asString(rec.user_id),
    threadTs: asString(rec.threadTs) ?? asString(rec.thread_ts) ?? asString(rec.ts),
    echo: rec.echo === true || rec.bot === true,
  };
}
