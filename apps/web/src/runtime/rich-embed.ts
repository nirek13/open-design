// Turn a pasted URL or local design path into a live preview spec.
// Known hosts (YouTube, Figma, Google, Notion, …) get a first-party embed
// player. Everything else becomes a rich card — many sites block iframes.

export type RichEmbedKind = 'iframe' | 'image' | 'video' | 'audio' | 'pdf' | 'card';

export interface RichEmbedModel {
  inputUrl: string;
  openUrl: string;
  kind: RichEmbedKind;
  src: string;
  provider: string;
  title: string;
  aspect: string;
  allow: string;
  sandbox: string;
  accent: string;
}

const IFRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen';
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation';
/** Same-origin /raw HTML must not inherit the parent origin. */
const LOCAL_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-forms allow-presentation';
const DEFAULT_ASPECT = '16 / 9';

const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:$|\?)/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|mov)(?:$|\?)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(?:$|\?)/i;
const PDF_EXT = /\.pdf(?:$|\?)/i;
const HTML_EXT = /\.(html?|xhtml)(?:$|\?)/i;

export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^\/(?:api|projects|artifacts|frames|s)\//i.test(trimmed)) return true;
  return /^(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(trimmed);
}

export function parseEmbedUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || /^\s*(javascript|data|vbscript|file):/i.test(trimmed)) return null;
  try {
    if (trimmed.startsWith('/')) {
      const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1';
      return new URL(trimmed, origin);
    }
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed);
    if (looksLikeUrl(trimmed)) return new URL(`https://${trimmed}`);
    return null;
  } catch {
    return null;
  }
}

export function isSafeEmbedUrl(raw: string): boolean {
  const url = parseEmbedUrl(raw);
  if (!url) return false;
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export function resolveRichEmbed(raw: string): RichEmbedModel | null {
  const inputUrl = raw.trim();
  if (!inputUrl) return null;
  const parsed = parseEmbedUrl(inputUrl);
  if (!parsed) return null;
  const openUrl = parsed.href;
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const path = parsed.pathname;

  const youtubeId = youtubeVideoId(parsed);
  if (youtubeId) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1`,
      provider: 'YouTube',
      accent: '#ff3b30',
    });
  }

  const vimeoId = matchHostPath(host, ['vimeo.com'], /^\/(?:video\/)?(\d+)/, path);
  if (vimeoId) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://player.vimeo.com/video/${vimeoId}`,
      provider: 'Vimeo',
      accent: '#19b7ea',
    });
  }

  const loomId = matchHostPath(host, ['loom.com'], /^\/(?:share|embed)\/([a-z0-9]+)/i, path);
  if (loomId) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://www.loom.com/embed/${loomId}`,
      provider: 'Loom',
      accent: '#625df5',
    });
  }

  if (host === 'figma.com' || host === 'figjam.com' || host.endsWith('.figma.com')) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://www.figma.com/embed?embed_host=opendesiign&url=${encodeURIComponent(openUrl)}`,
      provider: 'Figma',
      aspect: '4 / 3',
      accent: '#a259ff',
    });
  }

  const google = googleEmbed(parsed, host, path, inputUrl);
  if (google) return google;

  if (host === 'canva.com' || host.endsWith('.canva.com')) {
    const design = path.match(/\/design\/([^/]+)/i)?.[1];
    if (design) {
      return makeEmbed({
        inputUrl,
        openUrl,
        kind: 'iframe',
        src: `https://www.canva.com/design/${design}/view?embed`,
        provider: 'Canva',
        accent: '#00c4cc',
      });
    }
  }

  if (host === 'miro.com' || host.endsWith('.miro.com')) {
    const board = path.match(/\/(?:app\/)?board\/([^/]+)/i)?.[1];
    if (board) {
      return makeEmbed({
        inputUrl,
        openUrl,
        kind: 'iframe',
        src: `https://miro.com/app/live-embed/${board}/`,
        provider: 'Miro',
        accent: '#ffd02f',
      });
    }
  }

  if (host.endsWith('.notion.site') || host === 'notion.site') {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: openUrl,
      provider: 'Notion',
      aspect: '3 / 4',
      accent: '#111111',
    });
  }
  if (host === 'notion.so' || host.endsWith('.notion.so')) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'card',
      src: openUrl,
      provider: 'Notion',
      title: prettyHost(host),
      aspect: 'auto',
      accent: '#111111',
    });
  }

  const tweetId = tweetIdFrom(host, path);
  if (tweetId) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://platform.twitter.com/embed/Tweet.html?id=${tweetId}&dnt=true`,
      provider: 'X',
      aspect: '1 / 1',
      accent: '#111111',
    });
  }

  if (host === 'codesandbox.io' || host.endsWith('.codesandbox.io')) {
    const id = path.match(/\/(?:embed|s|p)\/([^/?]+)/i)?.[1] ?? path.split('/').filter(Boolean).at(-1);
    if (id) {
      return makeEmbed({
        inputUrl,
        openUrl,
        kind: 'iframe',
        src: `https://codesandbox.io/embed/${id}?fontsize=14&hidenavigation=1&theme=dark`,
        provider: 'CodeSandbox',
        accent: '#151515',
      });
    }
  }

  if (host === 'codepen.io') {
    const match = path.match(/\/(?:[^/]+\/)?(?:pen|embed)\/([^/]+)/i);
    if (match?.[1]) {
      return makeEmbed({
        inputUrl,
        openUrl,
        kind: 'iframe',
        src: `https://codepen.io/anon/embed/${match[1]}?default-tab=result`,
        provider: 'CodePen',
        accent: '#111111',
      });
    }
  }

  if (host === 'stackblitz.com') {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: openUrl.includes('/edit') ? openUrl.replace('/edit', '/embed') : openUrl,
      provider: 'StackBlitz',
      accent: '#1389fd',
    });
  }

  if (host === 'open.spotify.com' || host === 'spotify.com') {
    const kind = path.match(/\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
    if (kind) {
      return makeEmbed({
        inputUrl,
        openUrl,
        kind: 'iframe',
        src: `https://open.spotify.com/embed/${kind[1]}/${kind[2]}`,
        provider: 'Spotify',
        aspect: kind[1] === 'track' || kind[1] === 'episode' ? '24 / 7' : '1 / 1',
        accent: '#1db954',
      });
    }
  }

  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(openUrl)}&auto_play=false`,
      provider: 'SoundCloud',
      aspect: '21 / 5',
      accent: '#ff5500',
    });
  }

  if (host === 'typeform.com' || host.endsWith('.typeform.com')) {
    const id = path.match(/\/(?:to|e)\/([^/]+)/i)?.[1];
    if (id) {
      return makeEmbed({
        inputUrl,
        openUrl,
        kind: 'iframe',
        src: `https://form.typeform.com/to/${id}?typeform-embed=embed-widget`,
        provider: 'Typeform',
        aspect: '3 / 4',
        accent: '#262627',
      });
    }
  }

  if (host.includes('airtable.com')) {
    const embed = openUrl.includes('/embed/') ? openUrl : openUrl.replace('/shr', '/embed/shr');
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: embed,
      provider: 'Airtable',
      aspect: '4 / 3',
      accent: '#fcb400',
    });
  }

  if (IMAGE_EXT.test(path) || IMAGE_EXT.test(parsed.search)) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'image',
      src: openUrl,
      provider: 'Image',
      title: fileName(path) || 'Image',
      aspect: 'auto',
    });
  }
  if (VIDEO_EXT.test(path)) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'video',
      src: openUrl,
      provider: 'Video',
      title: fileName(path) || 'Video',
    });
  }
  if (AUDIO_EXT.test(path)) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'audio',
      src: openUrl,
      provider: 'Audio',
      title: fileName(path) || 'Audio',
      aspect: 'auto',
    });
  }
  if (PDF_EXT.test(path)) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'pdf',
      src: openUrl,
      provider: 'PDF',
      title: fileName(path) || 'PDF',
      aspect: '8.5 / 11',
    });
  }

  if (isLocalPreview(parsed) || HTML_EXT.test(path)) {
    const src = parsed.pathname.startsWith('/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : openUrl;
    const slides = isDeckFile(path);
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src,
      provider: slides ? 'Slides' : isLocalPreview(parsed) ? 'App' : prettyHost(host),
      title: fileName(path) || prettyHost(host),
      accent: slides ? '#c45c26' : '#d97757',
      sandbox: isLocalPreview(parsed) ? LOCAL_IFRAME_SANDBOX : IFRAME_SANDBOX,
    });
  }

  return makeEmbed({
    inputUrl,
    openUrl,
    kind: 'card',
    src: openUrl,
    provider: prettyHost(host),
    title: prettyHost(host),
    aspect: 'auto',
  });
}

export function iframeSnippet(model: RichEmbedModel): string {
  const src = model.kind === 'card' ? model.openUrl : model.src;
  const height = model.aspect === 'auto' ? 480 : Math.round(aspectHeight(model.aspect));
  return `<iframe src="${escapeAttr(src)}" title="${escapeAttr(model.title)}" style="width:100%;height:${height}px;border:0;border-radius:16px;" allow="${escapeAttr(model.allow)}" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
}

function makeEmbed(partial: {
  inputUrl: string;
  openUrl: string;
  kind: RichEmbedKind;
  src: string;
  provider: string;
  title?: string;
  aspect?: string;
  allow?: string;
  sandbox?: string;
  accent?: string;
}): RichEmbedModel {
  return {
    inputUrl: partial.inputUrl,
    openUrl: partial.openUrl,
    kind: partial.kind,
    src: partial.src,
    provider: partial.provider,
    title: partial.title ?? partial.provider,
    aspect: partial.aspect ?? DEFAULT_ASPECT,
    allow: partial.allow ?? IFRAME_ALLOW,
    sandbox: partial.sandbox ?? IFRAME_SANDBOX,
    accent: partial.accent ?? accentFor(partial.provider),
  };
}

function googleEmbed(parsed: URL, host: string, path: string, inputUrl: string): RichEmbedModel | null {
  if (!host.endsWith('google.com')) return null;
  const id = path.match(/\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/)?.[1] ?? parsed.searchParams.get('id');
  const openUrl = parsed.href;
  if (path.includes('/presentation/')) {
    const src = id
      ? `https://docs.google.com/presentation/d/${id}/embed?start=false&loop=false`
      : parsed.href.replace(/\/(edit|view|pub).*$/, '/embed');
    return makeEmbed({ inputUrl, openUrl, kind: 'iframe', src, provider: 'Google Slides', accent: '#f4b400' });
  }
  if (path.includes('/document/')) {
    const src = id
      ? `https://docs.google.com/document/d/${id}/preview`
      : parsed.href.replace(/\/(edit|view).*$/, '/preview');
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src,
      provider: 'Google Docs',
      aspect: '3 / 4',
      accent: '#4285f4',
    });
  }
  if (path.includes('/spreadsheets/')) {
    const src = id
      ? `https://docs.google.com/spreadsheets/d/${id}/preview`
      : parsed.href.replace(/\/(edit|view).*$/, '/preview');
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src,
      provider: 'Google Sheets',
      aspect: '16 / 10',
      accent: '#0f9d58',
    });
  }
  if (path.includes('/forms/')) {
    const src = parsed.href.includes('embedded=true')
      ? parsed.href
      : `${parsed.origin}${path.replace(/\/(edit|viewform).*$/, '/viewform')}?embedded=true`;
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src,
      provider: 'Google Form',
      aspect: '3 / 4',
      accent: '#673ab7',
    });
  }
  if (host === 'drive.google.com' && id) {
    return makeEmbed({
      inputUrl,
      openUrl,
      kind: 'iframe',
      src: `https://drive.google.com/file/d/${id}/preview`,
      provider: 'Google Drive',
      accent: '#1a73e8',
    });
  }
  return null;
}

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] ?? null;
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') return parts[1] ?? null;
  }
  return null;
}

function tweetIdFrom(host: string, path: string): string | null {
  if (host !== 'twitter.com' && host !== 'x.com' && host !== 'mobile.twitter.com') return null;
  return path.match(/\/status\/(\d+)/)?.[1] ?? null;
}

function matchHostPath(host: string, hosts: string[], pattern: RegExp, path: string): string | null {
  if (!hosts.some((item) => host === item || host.endsWith(`.${item}`))) return null;
  return path.match(pattern)?.[1] ?? null;
}

function isLocalPreview(url: URL): boolean {
  return (
    url.pathname.startsWith('/api/projects/') ||
    url.pathname.startsWith('/projects/') ||
    url.pathname.startsWith('/artifacts/') ||
    url.pathname.startsWith('/frames/') ||
    url.pathname.startsWith('/s/')
  );
}

function isDeckFile(path: string): boolean {
  const name = fileName(path);
  return /(?:^|[-_\s.])(deck|slides?|pitch|presentation)(?:[-_\s.]|$)/i.test(name);
}

function prettyHost(host: string): string {
  const trimmed = host.replace(/^www\./, '');
  const label = trimmed.split('.')[0] ?? trimmed;
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : trimmed;
}

function fileName(path: string): string {
  const part = path.split('/').filter(Boolean).at(-1) ?? '';
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function accentFor(provider: string): string {
  let hash = 0;
  for (let i = 0; i < provider.length; i++) hash = (hash * 31 + provider.charCodeAt(i)) >>> 0;
  const hues = ['#d97757', '#7c6cf0', '#0f9d58', '#4285f4', '#c45c26', '#2563eb', '#0f766e'];
  return hues[hash % hues.length] ?? '#d97757';
}

function aspectHeight(aspect: string): number {
  const match = aspect.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (!match) return 480;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return 480;
  return Math.round((720 * height) / width);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
