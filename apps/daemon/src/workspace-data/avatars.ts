// Profile photos live as files under the daemon data root, keyed by user id.
// The directory row only stores the sniffed MIME type so listings can tell
// whether a photo exists without opening the file.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { WorkspaceDataError } from './errors.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const USER_ID_RE = /^user-[A-Za-z0-9_-]+$/;

export function avatarFilePath(dataDir: string, userId: string): string {
  if (!USER_ID_RE.test(userId)) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'invalid user id');
  }
  return path.join(dataDir, 'avatars', userId);
}

export function sniffAvatar(buf: Buffer): { mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: 'image/gif' };
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp' };
  }
  return null;
}

export async function writeAvatarFile(dataDir: string, userId: string, buf: Buffer): Promise<string> {
  const kind = sniffAvatar(buf);
  if (!kind) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'photo must be a jpeg, png, webp, or gif');
  }
  if (buf.length > AVATAR_MAX_BYTES) {
    throw new WorkspaceDataError('PAYLOAD_TOO_LARGE', 413, 'photo must be under 2 MB');
  }
  const file = avatarFilePath(dataDir, userId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buf);
  return kind.mime;
}

export async function readAvatarFile(dataDir: string, userId: string): Promise<Buffer | null> {
  try {
    return await readFile(avatarFilePath(dataDir, userId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

export async function deleteAvatarFile(dataDir: string, userId: string): Promise<void> {
  try {
    await unlink(avatarFilePath(dataDir, userId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw err;
  }
}
