// Chat file blobs live under the daemon data root, keyed by organization
// then file id. The message row only stores the attachment JSON (id, name,
// mime, url) — the bytes stay on disk so a 20 MB clip does not bloat SQLite.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TeamChatAttachment } from '@open-design/contracts';
import { CHAT_FILE_MAX_BYTES } from '@open-design/contracts';
import { WorkspaceDataError } from './errors.js';

const FILE_ID_RE = /^file-[A-Za-z0-9-]+$/;
const ORG_ID_RE = /^[A-Za-z0-9._-]+$/;

const DANGEROUS_INLINE = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'application/javascript',
  'text/javascript',
]);

export interface StoredChatFile {
  id: string;
  orgId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  bytes: Buffer;
}

interface ChatFileMeta {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  createdAt: number;
}

function assertOrgId(orgId: string): string {
  if (!ORG_ID_RE.test(orgId) || orgId.includes('..')) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'invalid organization id');
  }
  return orgId;
}

function assertFileId(fileId: string): string {
  if (!FILE_ID_RE.test(fileId)) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'invalid chat file id');
  }
  return fileId;
}

export function chatFilesRoot(dataDir: string, orgId: string): string {
  return path.join(dataDir, 'chat-files', assertOrgId(orgId));
}

function fileDir(dataDir: string, orgId: string, fileId: string): string {
  return path.join(chatFilesRoot(dataDir, orgId), assertFileId(fileId));
}

export function sanitizeChatFileName(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f<>:"|?*\\/]+/g, '_').trim();
  const cleaned = base.replace(/^\.+/, '') || 'file';
  return cleaned.slice(0, 180);
}

export function sniffChatFileMime(buf: Buffer, fileName: string, declared?: string): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12
    && buf[0] === 0x52
    && buf[1] === 0x49
    && buf[2] === 0x46
    && buf[3] === 0x46
    && buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  const ext = path.extname(fileName).toLowerCase();
  const byExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.json': 'application/json',
    '.jsonl': 'application/jsonl',
    '.ics': 'text/calendar',
    '.vcf': 'text/vcard',
    '.rtf': 'application/rtf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.js': 'text/plain; charset=utf-8',
    '.mjs': 'text/plain; charset=utf-8',
    '.cjs': 'text/plain; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.tsx': 'text/plain; charset=utf-8',
    '.jsx': 'text/plain; charset=utf-8',
    '.py': 'text/plain; charset=utf-8',
    '.rb': 'text/plain; charset=utf-8',
    '.go': 'text/plain; charset=utf-8',
    '.rs': 'text/plain; charset=utf-8',
    '.java': 'text/plain; charset=utf-8',
    '.kt': 'text/plain; charset=utf-8',
    '.swift': 'text/plain; charset=utf-8',
    '.sql': 'text/plain; charset=utf-8',
    '.sh': 'text/plain; charset=utf-8',
    '.toml': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.diff': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.rar': 'application/vnd.rar',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
  };
  if (byExt[ext]) return byExt[ext];
  if (typeof declared === 'string' && declared.includes('/') && !declared.toLowerCase().includes('html')) {
    return declared.split(';')[0]!.trim();
  }
  return 'application/octet-stream';
}

export function chatFileContentDisposition(mimeType: string, fileName: string): string {
  const safe = sanitizeChatFileName(fileName).replace(/"/g, '');
  const mode = DANGEROUS_INLINE.has(mimeType.split(';')[0]!.trim().toLowerCase())
    ? 'attachment'
    : 'inline';
  return `${mode}; filename="${safe}"`;
}

export function chatFilePublicUrl(orgId: string, fileId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/chat/files/${encodeURIComponent(fileId)}`;
}

export async function writeChatFile(
  dataDir: string,
  orgId: string,
  buf: Buffer,
  originalName: string,
  declaredMime?: string,
): Promise<TeamChatAttachment> {
  if (buf.length === 0) {
    throw new WorkspaceDataError('VALIDATION_FAILED', 422, 'file is empty');
  }
  if (buf.length > CHAT_FILE_MAX_BYTES) {
    throw new WorkspaceDataError('PAYLOAD_TOO_LARGE', 413, 'file must be 25 MB or smaller');
  }
  const fileName = sanitizeChatFileName(originalName);
  const mimeType = sniffChatFileMime(buf, fileName, declaredMime);
  const id = `file-${randomUUID()}`;
  const dir = fileDir(dataDir, orgId, id);
  await mkdir(dir, { recursive: true });
  const meta: ChatFileMeta = {
    id,
    fileName,
    mimeType,
    byteSize: buf.length,
    createdAt: Date.now(),
  };
  await writeFile(path.join(dir, 'blob'), buf);
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return {
    kind: 'file',
    id,
    label: fileName,
    url: chatFilePublicUrl(orgId, id),
    mimeType,
    fileName,
    byteSize: buf.length,
  };
}

export async function readChatFile(
  dataDir: string,
  orgId: string,
  fileId: string,
): Promise<StoredChatFile | null> {
  const dir = fileDir(dataDir, orgId, fileId);
  try {
    const [rawMeta, bytes] = await Promise.all([
      readFile(path.join(dir, 'meta.json'), 'utf8'),
      readFile(path.join(dir, 'blob')),
    ]);
    const meta = JSON.parse(rawMeta) as ChatFileMeta;
    return {
      id: meta.id,
      orgId,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      byteSize: meta.byteSize,
      bytes,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}
