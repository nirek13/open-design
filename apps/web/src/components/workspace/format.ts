// Formatting shared by every workspace surface.
//
// The money rule is the important one: this product stores money as integer
// minor units everywhere, and converts to a decimal string at exactly two
// points — here for display, and in the record editor for input. No other
// module should divide by 100.

/** Render integer minor units as a decimal string. */
export function formatMoney(minor: number | null | undefined, locale?: string): string {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '—';
  return (minor / 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Money with an explicit sign, for deltas and running balances. */
export function formatSignedMoney(minor: number | null | undefined, locale?: string): string {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '—';
  const rendered = formatMoney(Math.abs(minor), locale);
  if (minor === 0) return rendered;
  return `${minor < 0 ? '−' : '+'}${rendered}`;
}

export function formatDate(value: string | number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: number | null | undefined, locale?: string): string {
  if (typeof value !== 'number') return '—';
  return new Date(value).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "3 minutes ago" style, coarse on purpose — precision here is noise. */
export function relativeTime(
  timestamp: number,
  t: (key: never, vars?: Record<string, string>) => string,
): string {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return t('workspace.minutesAgo' as never, { count: String(minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('workspace.hoursAgo' as never, { count: String(hours) });
  return t('workspace.daysAgo' as never, { count: String(Math.round(hours / 24)) });
}

/** Title-cases a machine name: `purchase_orders` -> `Purchase orders`. */
export function humanizeName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Table names are plural ("Invoices") but a create button acts on one of them
 * ("New invoice"). English-only and deliberately shallow: it handles the
 * endings real table names actually use and leaves anything else alone, which
 * is better than mangling a word it does not know. */
export function singularize(name: string): string {
  if (/(ss|us|is)$/i.test(name)) return name;
  if (/ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  if (/(ch|sh|x|z|s)es$/i.test(name)) return name.slice(0, -2);
  if (/s$/i.test(name)) return name.slice(0, -1);
  return name;
}
