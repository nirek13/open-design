// Tiny spreadsheet evaluator for page `spreadsheet` tools.
//
// Cell text that starts with `=` is a formula. Everything else is a literal
// (number if it parses, otherwise a label). Supported: + - * /, parentheses,
// A1 refs, ranges (A1:B3), and SUM / AVERAGE / AVG / MIN / MAX / COUNT / ABS /
// ROUND. Cycles and divide-by-zero become #CYCLE! / #DIV/0! so the grid
// never throws.

export const SHEET_ERROR = {
  cycle: '#CYCLE!',
  div: '#DIV/0!',
  err: '#ERR!',
} as const;

export function columnLetters(index: number): string {
  let n = Math.max(index, 0) + 1;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

export function cellAddress(row: number, col: number): string {
  return `${columnLetters(col)}${row + 1}`;
}

export function parseCellAddress(ref: string): { row: number; col: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const col = columnIndex(match[1] ?? '');
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0 || !Number.isFinite(row)) return null;
  return { row, col };
}

export function padSheet(cells: string[][], rows: number, cols: number): string[][] {
  const height = Math.max(rows, 1);
  const width = Math.max(cols, 1);
  return Array.from({ length: height }, (_, ri) => {
    const row = cells[ri] ?? [];
    return Array.from({ length: width }, (_, ci) => String(row[ci] ?? ''));
  });
}

export function formatSheetNumber(n: number): string {
  if (!Number.isFinite(n)) return SHEET_ERROR.err;
  if (Math.abs(n) < 1e-12) return '0';
  const rounded = Math.round(n * 1e10) / 1e10;
  return String(rounded);
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; row: number; col: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; value: string };

type CellResult = { ok: true; value: number | string } | { ok: false; error: string };

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = '';
      while (i < src.length && src[i] !== quote) {
        value += src[i];
        i += 1;
      }
      if (src[i] !== quote) return null;
      i += 1;
      tokens.push({ kind: 'str', value });
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] && src[i + 1]! >= '0' && src[i + 1]! <= '9')) {
      const start = i;
      i += 1;
      while (i < src.length && ((src[i]! >= '0' && src[i]! <= '9') || src[i] === '.')) i += 1;
      const value = Number(src.slice(start, i));
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: 'num', value });
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      const start = i;
      i += 1;
      while (i < src.length && /[A-Za-z0-9]/.test(src[i]!)) i += 1;
      const raw = src.slice(start, i);
      const addr = parseCellAddress(raw);
      if (addr) tokens.push({ kind: 'ref', row: addr.row, col: addr.col });
      else tokens.push({ kind: 'ident', name: raw.toUpperCase() });
      continue;
    }
    if ('+-*/(),:'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function asNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function evaluateSheet(cells: string[][]): string[][] {
  const height = cells.length;
  const width = cells.reduce((max, row) => Math.max(max, row.length), 0);
  const grid = padSheet(cells, height, width);
  const cache = new Map<string, CellResult>();
  const visiting = new Set<string>();

  const read = (row: number, col: number): CellResult => {
    const key = cellAddress(row, col);
    const cached = cache.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { ok: false, error: SHEET_ERROR.cycle };
    visiting.add(key);
    const raw = grid[row]?.[col] ?? '';
    const result = evalCell(raw, row, col);
    visiting.delete(key);
    cache.set(key, result);
    return result;
  };

  const collectRange = (a: { row: number; col: number }, b: { row: number; col: number }): CellResult[] => {
    const r0 = Math.min(a.row, b.row);
    const r1 = Math.max(a.row, b.row);
    const c0 = Math.min(a.col, b.col);
    const c1 = Math.max(a.col, b.col);
    const out: CellResult[] = [];
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        out.push(read(r, c));
      }
    }
    return out;
  };

  const evalCell = (raw: string, _row: number, _col: number): CellResult => {
    const text = raw.trim();
    if (!text) return { ok: true, value: '' };
    if (!text.startsWith('=')) {
      const n = Number(text);
      if (text !== '' && Number.isFinite(n)) return { ok: true, value: n };
      return { ok: true, value: text };
    }
    const tokens = tokenize(text.slice(1));
    if (!tokens) return { ok: false, error: SHEET_ERROR.err };
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => {
      const tok = tokens[pos];
      pos += 1;
      return tok;
    };
    const wantOp = (value: string) => {
      const tok = peek();
      return tok?.kind === 'op' && tok.value === value;
    };

    const flattenNums = (args: Array<number | string | CellResult[]>): CellResult => {
      const nums: number[] = [];
      const walk = (item: number | string | CellResult[]) => {
        if (Array.isArray(item)) {
          for (const entry of item) {
            if (!entry.ok) return entry;
            const n = asNumber(entry.value);
            if (n !== null) nums.push(n);
          }
          return null;
        }
        const n = asNumber(item);
        if (n === null) return { ok: false, error: SHEET_ERROR.err } as const;
        nums.push(n);
        return null;
      };
      for (const arg of args) {
        const fail = walk(arg);
        if (fail) return fail;
      }
      return { ok: true, value: nums as unknown as number };
    };

    const callFn = (name: string, args: Array<number | string | CellResult[]>): CellResult => {
      const numsResult = flattenNums(args);
      if (!numsResult.ok) return numsResult;
      const nums = numsResult.value as unknown as number[];
      switch (name) {
        case 'SUM':
          return { ok: true, value: nums.reduce((sum, n) => sum + n, 0) };
        case 'AVERAGE':
        case 'AVG':
          if (nums.length === 0) return { ok: false, error: SHEET_ERROR.div };
          return { ok: true, value: nums.reduce((sum, n) => sum + n, 0) / nums.length };
        case 'MIN':
          if (nums.length === 0) return { ok: false, error: SHEET_ERROR.err };
          return { ok: true, value: Math.min(...nums) };
        case 'MAX':
          if (nums.length === 0) return { ok: false, error: SHEET_ERROR.err };
          return { ok: true, value: Math.max(...nums) };
        case 'COUNT':
          return { ok: true, value: nums.length };
        case 'ABS':
          if (nums.length !== 1) return { ok: false, error: SHEET_ERROR.err };
          return { ok: true, value: Math.abs(nums[0]!) };
        case 'ROUND': {
          if (nums.length < 1 || nums.length > 2) return { ok: false, error: SHEET_ERROR.err };
          const digits = nums[1] ?? 0;
          const factor = 10 ** digits;
          return { ok: true, value: Math.round((nums[0] ?? 0) * factor) / factor };
        }
        default:
          return { ok: false, error: SHEET_ERROR.err };
      }
    };

    const parseArgs = (): Array<number | string | CellResult[]> | null => {
      const args: Array<number | string | CellResult[]> = [];
      if (wantOp(')')) return args;
      while (true) {
        const arg = parseExpr();
        if (arg === null) return null;
        args.push(arg);
        if (wantOp(',')) {
          take();
          continue;
        }
        break;
      }
      return args;
    };

    const parsePrimary = (): number | string | CellResult[] | null => {
      const tok = peek();
      if (!tok) return null;
      if (tok.kind === 'op' && tok.value === '(') {
        take();
        const inner = parseExpr();
        if (inner === null || !wantOp(')')) return null;
        take();
        return inner;
      }
      if (tok.kind === 'num') {
        take();
        return tok.value;
      }
      if (tok.kind === 'str') {
        take();
        return tok.value;
      }
      if (tok.kind === 'ref') {
        take();
        if (wantOp(':')) {
          take();
          const end = peek();
          if (end?.kind !== 'ref') return null;
          take();
          return collectRange(tok, end);
        }
        const cell = read(tok.row, tok.col);
        if (!cell.ok) return cell.error === SHEET_ERROR.cycle ? SHEET_ERROR.cycle : SHEET_ERROR.err;
        return cell.value;
      }
      if (tok.kind === 'ident') {
        take();
        if (!wantOp('(')) return null;
        take();
        const args = parseArgs();
        if (args === null || !wantOp(')')) return null;
        take();
        const result = callFn(tok.name, args);
        if (!result.ok) return result.error;
        return result.value;
      }
      return null;
    };

    const parseUnary = (): number | string | CellResult[] | null => {
      if (wantOp('+')) {
        take();
        return parseUnary();
      }
      if (wantOp('-')) {
        take();
        const inner = parseUnary();
        if (inner === null) return null;
        if (Array.isArray(inner)) return null;
        if (typeof inner === 'string' && inner.startsWith('#')) return inner;
        const n = asNumber(inner);
        if (n === null) return SHEET_ERROR.err;
        return -n;
      }
      return parsePrimary();
    };

    const parseTerm = (): number | string | CellResult[] | null => {
      let left = parseUnary();
      while (left !== null && (wantOp('*') || wantOp('/'))) {
        const op = take();
        const right = parseUnary();
        if (left === null || right === null || Array.isArray(left) || Array.isArray(right)) return null;
        if (typeof left === 'string' && left.startsWith('#')) return left;
        if (typeof right === 'string' && right.startsWith('#')) return right;
        const a = asNumber(left);
        const b = asNumber(right);
        if (a === null || b === null) return SHEET_ERROR.err;
        if (op?.kind === 'op' && op.value === '/') {
          if (b === 0) return SHEET_ERROR.div;
          left = a / b;
        } else {
          left = a * b;
        }
      }
      return left;
    };

    const parseExpr = (): number | string | CellResult[] | null => {
      let left = parseTerm();
      while (left !== null && (wantOp('+') || wantOp('-'))) {
        const op = take();
        const right = parseTerm();
        if (left === null || right === null || Array.isArray(left) || Array.isArray(right)) return null;
        if (typeof left === 'string' && left.startsWith('#')) return left;
        if (typeof right === 'string' && right.startsWith('#')) return right;
        const a = asNumber(left);
        const b = asNumber(right);
        if (a === null || b === null) return SHEET_ERROR.err;
        left = op?.kind === 'op' && op.value === '-' ? a - b : a + b;
      }
      return left;
    };

    const value = parseExpr();
    if (value === null || pos !== tokens.length) return { ok: false, error: SHEET_ERROR.err };
    if (Array.isArray(value)) {
      const nums = value
        .map((entry) => (entry.ok ? asNumber(entry.value) : null))
        .filter((n): n is number => n !== null);
      return { ok: true, value: nums.reduce((sum, n) => sum + n, 0) };
    }
    if (typeof value === 'string' && value.startsWith('#')) return { ok: false, error: value };
    return { ok: true, value };
  };

  return grid.map((row, ri) =>
    row.map((raw, ci) => {
      const result = read(ri, ci);
      if (!result.ok) return result.error;
      if (typeof result.value === 'number') return formatSheetNumber(result.value);
      return result.value;
    }),
  );
}

export function sheetPlainText(cells: string[][]): string {
  return cells
    .flat()
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' ');
}
