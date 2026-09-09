// Locale dictionaries, loaded one at a time.
//
// Every dictionary except `en` is behind a dynamic `import()` so the bundler
// emits one chunk per locale instead of folding all nineteen into the entry
// graph. That matters more than it sounds: statically importing the full set
// put ~6.7 MB of raw JS (~1.9 MB gzipped) in front of first paint, and a
// reader of any one language never looks at the other eighteen.
//
// `en` stays static because it is the synchronous fallback — `t()` must be
// able to return a string on the very first render, before any chunk has
// resolved, and every other dictionary falls back to it key by key.

import { en } from './locales/en';
import type { Dict, Locale } from './types';

type Loader = () => Promise<Dict>;

// A literal map, not a computed path: bundlers can only split what they can
// see statically, so `import(\`./locales/${locale}\`)` would defeat the point.
const LOADERS: Record<Locale, Loader> = {
  'en': async () => en,
  'id': () => import('./locales/id').then((m) => m.id),
  'de': () => import('./locales/de').then((m) => m.de),
  'zh-CN': () => import('./locales/zh-CN').then((m) => m.zhCN),
  'zh-TW': () => import('./locales/zh-TW').then((m) => m.zhTW),
  'pt-BR': () => import('./locales/pt-BR').then((m) => m.ptBR),
  'es-ES': () => import('./locales/es-ES').then((m) => m.esES),
  'ru': () => import('./locales/ru').then((m) => m.ru),
  'fa': () => import('./locales/fa').then((m) => m.fa),
  'ar': () => import('./locales/ar').then((m) => m.ar),
  'ja': () => import('./locales/ja').then((m) => m.ja),
  'ko': () => import('./locales/ko').then((m) => m.ko),
  'pl': () => import('./locales/pl').then((m) => m.pl),
  'hu': () => import('./locales/hu').then((m) => m.hu),
  'fr': () => import('./locales/fr').then((m) => m.fr),
  'uk': () => import('./locales/uk').then((m) => m.uk),
  'tr': () => import('./locales/tr').then((m) => m.tr),
  'th': () => import('./locales/th').then((m) => m.th),
  'it': () => import('./locales/it').then((m) => m.it),
};

const loaded: Partial<Record<Locale, Dict>> = { en };
const inFlight = new Map<Locale, Promise<Dict>>();
const listeners = new Set<() => void>();

/** The dictionary for `locale` if it has already been fetched, else null. */
export function loadedDict(locale: Locale): Dict | null {
  return loaded[locale] ?? null;
}

/** The English dictionary — always present, used as the per-key fallback. */
export const fallbackDict = en;

/**
 * Notified whenever a new dictionary lands. Consumers that read dictionaries
 * synchronously (see `tForLanguageTag`) need a re-render to pick one up.
 */
export function subscribeToDicts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch a locale's dictionary, at most once per locale. A failed chunk load
 * resolves to English rather than rejecting: a missing translation must
 * degrade to readable text, never to a blank screen.
 */
export function loadDict(locale: Locale): Promise<Dict> {
  const already = loaded[locale];
  if (already) return Promise.resolve(already);

  const pending = inFlight.get(locale);
  if (pending) return pending;

  const load = (LOADERS[locale] ?? LOADERS.en)()
    .catch(() => en)
    .then((dict) => {
      loaded[locale] = dict;
      inFlight.delete(locale);
      for (const listener of listeners) listener();
      return dict;
    });
  inFlight.set(locale, load);
  return load;
}
