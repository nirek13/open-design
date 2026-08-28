const QUESTION_FORM_RE = /<question-form\b[\s\S]*?<\/question-form>/gi;
const XMLISH_RE = /<\/?[a-zA-Z][\w:-]*(?:\s[^>]*)?>/g;
const DEFAULT_MAX = 1800;

export function stripPhoneMarkup(text: string): string {
  const withoutForms = text.replace(QUESTION_FORM_RE, '').trim();
  return withoutForms.replace(XMLISH_RE, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

export function formatPhoneReply(input: {
  text: string;
  studioUrl?: string | null;
  failed?: boolean;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? DEFAULT_MAX;
  let body = stripPhoneMarkup(input.text);
  if (!body) {
    body = input.failed
      ? 'That run did not finish. Open Open Design to see what happened.'
      : 'Done. Open Open Design to see the result.';
  }
  if (body.length > maxChars) body = `${body.slice(0, Math.max(0, maxChars - 1))}…`;
  const studio = input.studioUrl?.trim();
  if (studio) body = `${body}\n\nOpen in Open Design: ${studio}`;
  return body;
}

export function phoneWorkingAck(kind: 'slack' | 'imessage'): string {
  return kind === 'slack'
    ? 'On it — I will reply here when Open Design finishes.'
    : 'On it — I will text you when Open Design finishes.';
}
