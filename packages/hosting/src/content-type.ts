// Content types are decided once, at publish time, and stored in the manifest.
//
// The serving runtime never re-sniffs: every response goes out with
// `X-Content-Type-Options: nosniff`, so a wrong guess here becomes a blank page
// rather than a security problem, and a *sniffed* type would become the
// security problem instead (an uploaded `.txt` re-interpreted as HTML is the
// classic stored-XSS vector).

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function contentTypeFor(filePath: string): string {
  return EXTENSION_TYPES[extensionOf(filePath)] ?? DEFAULT_CONTENT_TYPE;
}

export function isHtmlPath(filePath: string): boolean {
  const ext = extensionOf(filePath);
  return ext === '.html' || ext === '.htm';
}
