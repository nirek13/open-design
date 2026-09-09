'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './locales/en';
import { getOpenDesignHost } from '@open-design/host';
import { LOCALES, type Dict, type Locale } from './types';
import { fallbackDict, loadDict, loadedDict, subscribeToDicts } from './registry';

export { LOCALES, LOCALE_LABEL } from './types';
export type { Locale } from './types';

type DictKey = keyof Dict;

/** Substitute `{name}` placeholders, leaving unknown names visible. */
function interpolate(raw: string, vars?: Record<string, string | number>): string {
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    return value == null ? `{${name}}` : String(value);
  });
}


const LS_KEY = 'open-design:locale';
// Marker that says "the value in LS_KEY came from a deliberate user
// action through setLocale, not from some auto-detection path". Only
// values tagged this way win over the desktop host's injected OS
// locale, so a stale auto-detected pick can't pin the app forever once
// the user changes their system language.
const LS_SOURCE_KEY = 'open-design:locale-source';
const MANUAL_LOCALE_SOURCE = 'manual';

export function resolveSystemLocale(languages: readonly string[]): Locale | null {
  const supported = LOCALES as readonly string[];
  for (const raw of languages) {
    const normalized = raw.trim();
    if (!normalized) continue;

    const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    const [language, regionOrScript] = normalized.toLowerCase().split('-');
    if (language === 'zh') {
      if (regionOrScript === 'hant' || regionOrScript === 'tw' || regionOrScript === 'hk' || regionOrScript === 'mo') {
        return 'zh-TW';
      }
      return 'zh-CN';
    }

    const baseMatch = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language);
    if (baseMatch && supported.includes(baseMatch)) return baseMatch;
  }
  return null;
}

/**
 * A `t()` bound to an explicit content-language tag rather than the app UI
 * locale. Used by the question-form card so host-rendered strings inside the
 * card (the "Other" chip, custom-answer copy) match the language the model
 * localized the form into — a Chinese form in an English UI must not mix
 * scripts. Returns null when the tag doesn't resolve to a bundled locale;
 * callers fall back to the context `t`.
 */
export function tForLanguageTag(
  tag: string | undefined,
): ((key: DictKey, vars?: Record<string, string | number>) => string) | null {
  if (!tag || !tag.trim()) return null;
  const locale = resolveSystemLocale([tag]);
  if (!locale) return null;
  // Dictionaries load on demand, so a content language the UI has never
  // rendered may not be here yet. Translate with what we have and request
  // the rest; `subscribeToDicts` re-renders the tree when it lands.
  const dict = loadedDict(locale);
  if (!dict) void loadDict(locale);
  return (key, vars) =>
    interpolate((dict ?? fallbackDict)[key] ?? fallbackDict[key] ?? key, vars);
}

// Read the OS locale the desktop host attached to its client descriptor.
// Packaged desktop builds need this because Chromium otherwise reports
// en-US through navigator.language regardless of the OS setting. We go
// through `getOpenDesignHost` rather than reading the bridge global by
// name so the web/preload boundary stays single-source (see the
// `host bridge boundary` guard test).
function readDesktopHostOsLocale(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const host = getOpenDesignHost();
  const value = host?.client?.osLocale;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// First-run defaults to the user's OS / browser language when possible.
// Priority: explicit user pick saved to localStorage (only when tagged
// as manual) > OS locale that the desktop host injected (packaged
// Electron) > navigator.languages > 'en'. The source tag matters
// because untagged localStorage values are treated as legacy /
// auto-detected — they don't override a fresh OS locale read.
// Exported so tests can pin the priority chain without spinning up the
// full I18nProvider.
export function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  let storedLocale: string | null = null;
  let storedSource: string | null = null;
  try {
    storedLocale = window.localStorage.getItem(LS_KEY);
    storedSource = window.localStorage.getItem(LS_SOURCE_KEY);
  } catch {
    /* ignore */
  }
  if (
    storedSource === MANUAL_LOCALE_SOURCE &&
    storedLocale &&
    (LOCALES as string[]).includes(storedLocale)
  ) {
    return storedLocale as Locale;
  }
  const hostOsLocale = readDesktopHostOsLocale();
  if (hostOsLocale) {
    const fromHost = resolveSystemLocale([hostOsLocale]);
    if (fromHost) return fromHost;
  }
  const detected = resolveSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );
  return detected ?? 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

interface ProviderProps {
  initial?: Locale;
  children: ReactNode;
}

const RTL_LOCALES: Locale[] = ['ar', 'fa'];

const ARABIC_FONT_ID = 'od-rtl-font';
const ARABIC_FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap';

/**
 * Request Cairo, and only for the readers who see it. The RTL type stack in
 * `styles/viewer/library.css` names it first but falls through to Vazirmatn,
 * Noto Sans Arabic and Tahoma, so a blocked or offline request costs nothing
 * but the preferred face. Injected once and left in place — switching away
 * from Arabic mid-session does not need to undo a cached stylesheet.
 */
function ensureRtlFontLoaded(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(ARABIC_FONT_ID)) return;
  const link = document.createElement('link');
  link.id = ARABIC_FONT_ID;
  link.rel = 'stylesheet';
  link.href = ARABIC_FONT_HREF;
  document.head.appendChild(link);
}

export function I18nProvider({ initial, children }: ProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? detectInitialLocale());
  const [dict, setDict] = useState<Dict>(() => loadedDict(locale) ?? fallbackDict);
  // The very first paint must not show English to a Japanese reader, so it
  // waits for the active dictionary's chunk. Later switches keep rendering
  // the outgoing language instead of blanking the app mid-session.
  const [booted, setBooted] = useState(() => loadedDict(locale) != null);

  useEffect(() => {
    let cancelled = false;
    const cachedDict = loadedDict(locale);
    if (cachedDict) {
      setDict(cachedDict);
      setBooted(true);
      return;
    }
    void loadDict(locale).then((next) => {
      if (cancelled) return;
      setDict(next);
      setBooted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // A dictionary fetched for some *other* language (a question form rendered
  // in the model's language) has to reach the components already mounted.
  const [dictVersion, setDictVersion] = useState(0);
  useEffect(() => subscribeToDicts(() => setDictVersion((n) => n + 1)), []);

  // Keep <html lang="…" dir="…"> in sync so screen readers and CSS hooks
  // pick the right language token and direction without each component
  // having to set it itself.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('lang', locale);
      document.documentElement.setAttribute('dir', dir);
      if (dir === 'rtl') ensureRtlFontLoaded();
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LS_KEY, next);
      // Marker so detectInitialLocale knows this came from a deliberate
      // user action and should beat the desktop host's OS locale.
      window.localStorage.setItem(LS_SOURCE_KEY, MANUAL_LOCALE_SOURCE);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>): string =>
      interpolate(dict[key] ?? fallbackDict[key] ?? key, vars),
    // `dictVersion` is not read here; it is in the dependency list so a
    // dictionary landing for another language produces a fresh `t`
    // identity and re-runs the memos downstream of it.
    [dict, dictVersion],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  // Hold the boot shell rather than flashing English at a reader who asked
  // for something else. This is the same markup `app/[[...slug]]/client-app.tsx`
  // shows while the App chunk loads, so the two waits read as one and the
  // screen never goes blank in between. The dictionary is a same-origin
  // chunk — a tick, not a round trip — and `en` is resident, so the common
  // case never reaches this at all.
  if (!booted) return <div className="od-loading-shell">Loading Plyxl…</div>;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fall back to a stand-alone English translator when no provider is
    // mounted (e.g. an isolated test). This keeps the API safe to call
    // without requiring every callsite to wrap in a provider.
    return {
      locale: 'en',
      setLocale: () => { },
      t: (key, vars) => interpolate(en[key] ?? key, vars),
    };
  }
  return ctx;
}

// Convenience for components that only need the translator function.
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
