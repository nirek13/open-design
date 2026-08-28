/** Split a CSV/TSV body into header + preview rows for the import dialog. */

export function previewRowsFromCsv(content: string, maxRows = 12): {
  headers: string[];
  rows: string[][];
  totalRows: number;
} {
  const records = parseDelimited(content);
  if (records.length === 0) return { headers: [], rows: [], totalRows: 0 };
  const headers = records[0] ?? [];
  const body = records.slice(1);
  return {
    headers,
    rows: body.slice(0, maxRows),
    totalRows: body.length,
  };
}

function detectDelimiter(text: string): string {
  const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = [
    { d: '\t', n: first.split('\t').length },
    { d: ',', n: first.split(',').length },
    { d: ';', n: first.split(';').length },
    { d: '|', n: first.split('|').length },
  ];
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 1 ? counts[0].d : ',';
}

function parseDelimited(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' || (ch === '\r' && next === '\n')) {
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      if (ch === '\r') i += 1;
      continue;
    }
    if (ch === '\r') {
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}
