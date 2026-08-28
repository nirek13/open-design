/** A pasted http(s) link, optionally introduced with import/scrape/read. */
const URL_ONLY = /^(https?:\/\/[^\s]+)$/i;
const COMMANDED = /^(?:import|scrape|read|fetch)\s+(https?:\/\/[^\s]+)\s*$/i;

export function importUrlFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const only = URL_ONLY.exec(trimmed);
  if (only?.[1]) return only[1];
  const commanded = COMMANDED.exec(trimmed);
  if (commanded?.[1]) return commanded[1];
  return null;
}
