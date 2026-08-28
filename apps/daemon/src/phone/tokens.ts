import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hashPhoneToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function phoneTokenHashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateInboundToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Short code a person can type from Messages or Slack to finish pairing. */
export function generatePairingCode(): string {
  const bytes = randomBytes(4);
  let code = '';
  for (let i = 0; i < 4; i += 1) {
    code += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  }
  return `OD-${code}`;
}

export function pairingCodeInText(text: string, pairingCode: string): boolean {
  const needle = pairingCode.trim().toUpperCase().replace(/\s+/g, '');
  if (!needle) return false;
  const haystack = text.toUpperCase().replace(/\s+/g, '');
  return haystack.includes(needle);
}
