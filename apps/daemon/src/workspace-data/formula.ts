// Computed fields: formulas and rollups.
//
// A formula field stores nothing. It is evaluated when a record is read, from
// the record's own values, so it can never disagree with the data it is
// derived from — the failure mode of a stored computed column is that it goes
// stale silently and nobody finds out until a total is wrong.
//
// The evaluator is a hand-written recursive-descent parser over a tiny
// grammar. Not `eval`, not `new Function`: a formula is user input that
// arrives over HTTP, and handing user input to the JavaScript engine is remote
// code execution wearing a spreadsheet costume. This parser can only produce
// numbers, strings, and booleans — there is no syntax for reaching anything
// outside the record.
//
// Money stays in integer minor units throughout. `total * 0.2` on a money
// field yields minor units, and rounding happens once, at the end.

import type { WorkspaceField, WorkspaceRecord, WorkspaceTable } from '@open-design/contracts';
import { workspaceValidationError } from './errors.js';

export type FormulaValue = number | string | boolean | null;

/** How much work one formula may do. A formula is evaluated once per row per
 * read, so an accidental quadratic is a hang; the ceiling makes it an error. */
const MAX_NODES = 200;

// --- Tokenizer ------------------------------------------------------------

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'field'; name: string }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    // `{Field Name}` — braces because field names contain spaces, and because
    // an explicit delimiter means a field can never be confused with a
    // function name or a bare word.
    if (char === '{') {
      const end = source.indexOf('}', i);
      if (end === -1) throw formulaError('unclosed { in formula');
      tokens.push({ kind: 'field', name: source.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = source.indexOf(char, i + 1);
      if (end === -1) throw formulaError('unclosed string in formula');
      tokens.push({ kind: 'string', value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    if (/[0-9]/.test(char)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ kind: 'number', value: Number.parseFloat(match[0]) });
      i += match[0].length;
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'ident', name: match[0] });
      i += match[0].length;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }

    if ('+-*/%><'.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      i += 1;
      continue;
    }

    if ('(),'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      i += 1;
      continue;
    }

    throw formulaError(`unexpected character '${char}' in formula`);
  }

  return tokens;
}

function formulaError(message: string) {
  return workspaceValidationError([{ path: 'formula', message }]);
}

// --- Parser ---------------------------------------------------------------

type Node =
  | { kind: 'literal'; value: FormulaValue }
  | { kind: 'field'; name: string }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'call'; name: string; args: Node[] };

/** Precedence, loosest first. Standard arithmetic order, so `a + b * c` means
 * what everyone expects without parentheses. */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '>': 4,
  '>=': 4,
  '<': 4,
  '<=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

export function parseFormula(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;
  let nodeCount = 0;

  const count = <T extends Node>(node: T): T => {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw formulaError('formula is too complex');
    return node;
  };

  const peek = () => tokens[position];
  const next = () => tokens[position++];

  function parseExpression(minPrecedence = 0): Node {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (!token || token.kind !== 'op') break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      next();
      // Left-associative: everything binding tighter goes to the right.
      const right = parseExpression(precedence + 1);
      left = count({ kind: 'binary', op: token.value, left, right });
    }
    return left;
  }

  function parseUnary(): Node {
    const token = peek();
    if (token?.kind === 'op' && token.value === '-') {
      next();
      return count({ kind: 'unary', op: '-', operand: parseUnary() });
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const token = next();
    if (!token) throw formulaError('formula ended unexpectedly');

    if (token.kind === 'number') return count({ kind: 'literal', value: token.value });
    if (token.kind === 'string') return count({ kind: 'literal', value: token.value });
    if (token.kind === 'field') return count({ kind: 'field', name: token.name });

    if (token.kind === 'ident') {
      if (peek()?.kind === 'punct' && (peek() as { value: string }).value === '(') {
        next();
        const args: Node[] = [];
        if (!(peek()?.kind === 'punct' && (peek() as { value: string }).value === ')')) {
          for (;;) {
            args.push(parseExpression());
            const separator = peek();
            if (separator?.kind === 'punct' && separator.value === ',') {
              next();
              continue;
            }
            break;
          }
        }
        const close = next();
        if (!close || close.kind !== 'punct' || close.value !== ')') {
          throw formulaError(`expected ) after ${token.name}(`);
        }
        const name = token.name.toUpperCase();
        // Checked here rather than at evaluation so a typo — or a name that
        // hopefully reaches the host, like `require(...)` — is rejected when
        // the formula is saved instead of silently blanking a column later.
        if (!Object.hasOwn(FUNCTIONS, name)) {
          throw formulaError(
            `unknown function ${token.name}() — available: ${Object.keys(FUNCTIONS).sort().join(', ')}`,
          );
        }
        return count({ kind: 'call', name, args });
      }
      const upper = token.name.toUpperCase();
      if (upper === 'TRUE') return count({ kind: 'literal', value: true });
      if (upper === 'FALSE') return count({ kind: 'literal', value: false });
      if (upper === 'NULL') return count({ kind: 'literal', value: null });
      throw formulaError(`unknown name '${token.name}' — wrap field names in { }`);
    }

    if (token.kind === 'punct' && token.value === '(') {
      const inner = parseExpression();
      const close = next();
      if (!close || close.kind !== 'punct' || close.value !== ')') {
        throw formulaError('expected )');
      }
      return inner;
    }

    throw formulaError('could not read formula');
  }

  const result = parseExpression();
  if (position < tokens.length) throw formulaError('unexpected trailing input in formula');
  return result;
}

// --- Evaluation -----------------------------------------------------------

function toNumber(value: FormulaValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function truthy(value: FormulaValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  return false;
}

const FUNCTIONS: Record<string, (args: FormulaValue[]) => FormulaValue> = {
  IF: (args) => (truthy(args[0] ?? null) ? (args[1] ?? null) : (args[2] ?? null)),
  SUM: (args) => args.reduce<number>((total, value) => total + toNumber(value), 0),
  MIN: (args) => Math.min(...args.map(toNumber)),
  MAX: (args) => Math.max(...args.map(toNumber)),
  ABS: (args) => Math.abs(toNumber(args[0] ?? null)),
  ROUND: (args) => {
    const places = args.length > 1 ? toNumber(args[1] ?? null) : 0;
    const factor = 10 ** places;
    return Math.round(toNumber(args[0] ?? null) * factor) / factor;
  },
  FLOOR: (args) => Math.floor(toNumber(args[0] ?? null)),
  CEIL: (args) => Math.ceil(toNumber(args[0] ?? null)),
  CONCAT: (args) => args.map((value) => (value === null ? '' : String(value))).join(''),
  UPPER: (args) => String(args[0] ?? '').toUpperCase(),
  LOWER: (args) => String(args[0] ?? '').toLowerCase(),
  LEN: (args) => String(args[0] ?? '').length,
  NOT: (args) => !truthy(args[0] ?? null),
  // Blank-safe default: the reason most spreadsheet formulas break is an
  // empty cell partway through.
  COALESCE: (args) => args.find((value) => value !== null && value !== '') ?? null,
  ISBLANK: (args) => args[0] === null || args[0] === undefined || args[0] === '',
};

export function evaluateFormula(node: Node, values: Record<string, unknown>): FormulaValue {
  switch (node.kind) {
    case 'literal':
      return node.value;

    case 'field': {
      const raw = values[node.name];
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') return raw;
      return null;
    }

    case 'unary':
      return -toNumber(evaluateFormula(node.operand, values));

    case 'binary': {
      const left = evaluateFormula(node.left, values);
      const right = evaluateFormula(node.right, values);
      switch (node.op) {
        case '+':
          // `+` concatenates when either side is text, adds otherwise — the
          // one place this grammar overloads an operator, because "Invoice " +
          // {number} is the single most common thing people write.
          if (typeof left === 'string' || typeof right === 'string') {
            return `${left ?? ''}${right ?? ''}`;
          }
          return toNumber(left) + toNumber(right);
        case '-':
          return toNumber(left) - toNumber(right);
        case '*':
          return toNumber(left) * toNumber(right);
        case '/': {
          const divisor = toNumber(right);
          // Null rather than Infinity: "we cannot say" is the honest answer,
          // and Infinity poisons every total downstream.
          return divisor === 0 ? null : toNumber(left) / divisor;
        }
        case '%': {
          const divisor = toNumber(right);
          return divisor === 0 ? null : toNumber(left) % divisor;
        }
        case '>':
          return toNumber(left) > toNumber(right);
        case '>=':
          return toNumber(left) >= toNumber(right);
        case '<':
          return toNumber(left) < toNumber(right);
        case '<=':
          return toNumber(left) <= toNumber(right);
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '&&':
          return truthy(left) && truthy(right);
        case '||':
          return truthy(left) ? left : right;
        default:
          throw formulaError(`unknown operator ${node.op}`);
      }
    }

    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw formulaError(`unknown function ${node.name}()`);
      return fn(node.args.map((arg) => evaluateFormula(arg, values)));
    }
  }
}

/** Field names a formula reads, so a caller can detect a cycle before running
 * anything. */
export function formulaDependencies(node: Node): string[] {
  const names = new Set<string>();
  const walk = (current: Node) => {
    if (current.kind === 'field') names.add(current.name);
    else if (current.kind === 'binary') {
      walk(current.left);
      walk(current.right);
    } else if (current.kind === 'unary') walk(current.operand);
    else if (current.kind === 'call') current.args.forEach(walk);
  };
  walk(node);
  return [...names];
}

// --- Applying to records --------------------------------------------------

export function isComputedField(field: WorkspaceField): boolean {
  const config = field.config as { formula?: string; rollup?: unknown } | null;
  return typeof config?.formula === 'string' || config?.rollup !== undefined;
}

/** Compute every formula field on a record and return a copy with them filled
 * in. Computed values are never written back — a read produces them, so they
 * cannot drift from the data they describe.
 *
 * A formula that refers to another formula field sees `null` rather than a
 * chained result. One level keeps evaluation obviously terminating; the
 * alternative is a dependency graph and cycle detection at read time, which is
 * a lot of machinery for a case nobody has asked for yet. */
export function applyFormulas(table: WorkspaceTable, record: WorkspaceRecord): WorkspaceRecord {
  const computed = table.fields.filter(isComputedField);
  if (computed.length === 0) return record;

  const data = { ...record.data };
  for (const field of computed) {
    const config = field.config as { formula?: string } | null;
    if (typeof config?.formula !== 'string') continue;
    try {
      data[field.name] = evaluateFormula(parseFormula(config.formula), record.data) as never;
    } catch {
      // A broken formula shows as blank rather than failing the whole read.
      // One bad column must not make a table unopenable.
      data[field.name] = null as never;
    }
  }
  return { ...record, data };
}

/** Roll a linked table up into a number: "how much have they ordered". */
export interface RollupConfig {
  /** Link field on THIS table pointing at the other one. */
  via: string;
  /** Field on the linked records to aggregate. */
  field: string;
  fn: 'sum' | 'count' | 'avg' | 'min' | 'max';
}

export function computeRollup(
  config: RollupConfig,
  linkedRecords: WorkspaceRecord[],
): number | null {
  if (config.fn === 'count') return linkedRecords.length;
  const numbers = linkedRecords
    .map((record) => record.data[config.field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) return config.fn === 'sum' ? 0 : null;

  switch (config.fn) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0);
    case 'avg':
      // Rounded to an integer because a rollup over money must stay in whole
      // minor units.
      return Math.round(numbers.reduce((total, value) => total + value, 0) / numbers.length);
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
    default:
      return null;
  }
}
