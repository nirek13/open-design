// Turning a sentence into a plan.
//
// A deterministic parser, not a model. That is a deliberate trade: it handles
// a bounded grammar perfectly, instantly, offline, and for free, and it says
// "I don't know" everywhere else instead of guessing. A model behind this box
// would be more flexible and less trustworthy — the failure mode of a
// statistical parser is a confident wrong plan, and a confident wrong plan is
// the one that gets approved.
//
// So the rule throughout: match narrowly, report what was not matched, and
// route anything outside the grammar to the assistant, which goes through the
// same proposal preview anyway.
//
// Nothing here writes. `interpretIntent` reads the schema to resolve names and
// returns operations; applying them is a separate, explicit call.

import {
  INTENT_EXAMPLES,
  type IntentKind,
  type IntentQueryPlan,
  type InterpretIntentResponse,
  type SchemaChangePlan,
  type ProposalOperation,
  type WorkspaceFieldType,
  type WorkspaceRecordFilter,
  type WorkspaceRecordSort,
  type WorkspaceTable,
} from '@open-design/contracts';
import { listTables } from './schema.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

// --- Vocabulary -----------------------------------------------------------

/** Words people use for a type, mapped to the type the engine has. Ordered
 * longest-first at match time so "phone number" beats "number". */
const TYPE_WORDS: ReadonlyArray<{ words: string[]; type: WorkspaceFieldType }> = [
  { words: ['email', 'e-mail', 'email address'], type: 'text' },
  { words: ['phone', 'phone number', 'telephone', 'mobile'], type: 'text' },
  { words: ['money', 'amount', 'price', 'cost', 'currency', 'value'], type: 'money' },
  { words: ['date', 'day'], type: 'date' },
  { words: ['datetime', 'timestamp', 'time'], type: 'datetime' },
  { words: ['checkbox', 'boolean', 'yes/no', 'yes no', 'true/false', 'flag'], type: 'boolean' },
  { words: ['integer', 'whole number', 'count'], type: 'integer' },
  { words: ['number', 'numeric', 'decimal'], type: 'number' },
  { words: ['select', 'dropdown', 'choice', 'option', 'status'], type: 'select' },
  { words: ['link', 'relation', 'reference'], type: 'link' },
  { words: ['json', 'data'], type: 'json' },
  { words: ['text', 'string', 'note', 'notes', 'description'], type: 'text' },
];

/** Field names that carry a type by convention, so "add a phone" gets a text
 * field and "add a due date" gets a date without anyone saying the word. */
const NAME_TYPE_HINTS: ReadonlyArray<{ test: RegExp; type: WorkspaceFieldType }> = [
  { test: /(^|_)(email|e_mail)($|_)/, type: 'text' },
  { test: /(^|_)(phone|mobile|fax)($|_)/, type: 'text' },
  { test: /(^|_)(date|deadline|birthday)($|_)|_at$|_on$/, type: 'date' },
  { test: /(^|_)(total|subtotal|price|cost|amount|budget|salary|fee|rate)($|_)/, type: 'money' },
  { test: /(^|_)(qty|quantity|count|units|stock)($|_)/, type: 'integer' },
  { test: /(^|_)(is|has|can)_/, type: 'boolean' },
  { test: /(^|_)(status|stage|priority|kind|category|type)($|_)/, type: 'select' },
  { test: /(^|_)(notes|note|description|summary|comment)($|_)/, type: 'text' },
];

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'and', 'called',
  'named', 'new', 'please', 'my', 'our', 'field', 'column', 'property',
]);

/** Turn a phrase into a machine name the schema will accept. */
export function machineName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 63);
}

function titleCase(input: string): string {
  const spaced = input.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// --- Fuzzy name resolution ------------------------------------------------

/** Levenshtein distance, capped — we only care whether it is small. Used so
 * "custmers" still finds `customers` rather than failing on a typo, which is
 * the difference between a tool that feels alive and one that feels brittle. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Singular/plural tolerant: people say "add a customer", the table is
 * `customers`. Both directions, because tables get named either way. */
function nameVariants(name: string): string[] {
  const out = new Set([name]);
  if (name.endsWith('ies')) out.add(`${name.slice(0, -3)}y`);
  if (name.endsWith('s')) out.add(name.slice(0, -1));
  out.add(`${name}s`);
  if (name.endsWith('y')) out.add(`${name.slice(0, -1)}ies`);
  return [...out];
}

export interface ResolvedName<T> {
  value: T;
  /** 1 for exact, lower for a plural or a typo. Feeds overall confidence, so
   * "custmers" produces a plan the UI marks as less certain. */
  score: number;
}

function bestMatch<T>(
  needle: string,
  candidates: Array<{ key: string; alt: string[]; value: T }>,
): ResolvedName<T> | null {
  const target = machineName(needle);
  if (!target) return null;
  let best: ResolvedName<T> | null = null;

  for (const candidate of candidates) {
    const keys = [candidate.key, ...candidate.alt].map(machineName);
    for (const key of keys) {
      let score = 0;
      if (key === target) score = 1;
      else if (nameVariants(key).includes(target) || nameVariants(target).includes(key)) score = 0.92;
      else {
        const distance = editDistance(key, target);
        // Only forgive a typo on a word long enough that the typo is
        // unambiguous; on short names a one-character difference is usually a
        // different word ("tax" vs "fax").
        if (distance <= 2 && Math.min(key.length, target.length) >= 5) {
          score = distance === 1 ? 0.8 : 0.65;
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { value: candidate.value, score };
    }
  }
  return best;
}

export function resolveTableName(
  tables: WorkspaceTable[],
  needle: string,
): ResolvedName<WorkspaceTable> | null {
  return bestMatch(
    needle,
    tables.map((table) => ({ key: table.name, alt: [table.displayName], value: table })),
  );
}

export function resolveFieldName(table: WorkspaceTable, needle: string) {
  return bestMatch(
    needle,
    table.fields.map((field) => ({ key: field.name, alt: [field.displayName], value: field })),
  );
}

// --- Type inference -------------------------------------------------------

/** The type a new field should get, from an explicit word if there is one and
 * from the name's shape otherwise. */
export function inferFieldType(phrase: string, fieldName: string): WorkspaceFieldType {
  const haystack = ` ${phrase.toLowerCase()} `;
  const byWord = [...TYPE_WORDS]
    .flatMap((entry) => entry.words.map((word) => ({ word, type: entry.type })))
    // Longest phrase first so "phone number" is not read as "number".
    .sort((a, b) => b.word.length - a.word.length)
    .find((entry) => haystack.includes(` ${entry.word} `));
  if (byWord) return byWord.type;

  const machine = machineName(fieldName);
  const byName = NAME_TYPE_HINTS.find((hint) => hint.test.test(machine));
  return byName?.type ?? 'text';
}

// --- Value coercion -------------------------------------------------------

/** Read a written amount as integer minor units. "$1,250.50" -> 125050.
 * Money is integer minor units everywhere in this system, and this is the one
 * place a typed sentence crosses into that representation. */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$£€,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number.parseFloat(cleaned) * 100);
}

const DATE_WORDS: Record<string, () => string> = {
  today: () => new Date().toISOString().slice(0, 10),
  tomorrow: () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  yesterday: () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
};

/** Coerce a written value to what the field's type needs. Returns undefined
 * when it cannot, so the caller can leave the field unset rather than storing
 * a string in a money column. */
export function coerceValue(raw: string, type: WorkspaceFieldType): unknown {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return undefined;

  switch (type) {
    case 'money':
      return parseMoney(trimmed) ?? undefined;
    case 'integer': {
      const n = Number.parseInt(trimmed.replace(/[,\s]/g, ''), 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'number': {
      const n = Number.parseFloat(trimmed.replace(/[,\s]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      if (/^(yes|true|y|1|done|checked)$/i.test(trimmed)) return true;
      if (/^(no|false|n|0|open|unchecked)$/i.test(trimmed)) return false;
      return undefined;
    }
    case 'date': {
      const word = DATE_WORDS[trimmed.toLowerCase()];
      if (word) return word();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
    }
    case 'datetime': {
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    default:
      return trimmed;
  }
}

// --- The grammar ----------------------------------------------------------

interface Ctx {
  tables: WorkspaceTable[];
  /** The table the person is looking at, used when the sentence omits one. */
  current: WorkspaceTable | null;
}

interface Match {
  kind: IntentKind;
  summary: string;
  confidence: number;
  operations: ProposalOperation[];
  query?: IntentQueryPlan;
  unmatched?: string;
  schemaChange?: SchemaChangePlan;
}

type Rule = (text: string, ctx: Ctx) => Match | null;

/** "add a phone column to customers" / "add a due date to invoices" */
const addField: Rule = (text, ctx) => {
  // Alternations are longest-first throughout this file. `a|an` would match
  // the "a" of "an email" and leave "n email" as the field name.
  const m =
    /^(?:add|create|make)\s+(?:another|an|a)?\s*(.+?)\s+(?:column|field|property)(?:\s+(?:to|on|in)\s+(.+?))?$/i.exec(text) ??
    /^(?:add|create|make)\s+(?:another|an|a)\s+(.+?)\s+(?:to|on|in)\s+(.+?)$/i.exec(text);
  if (!m) return null;

  const rawField = m[1]!.trim();
  const rawTable = m[2]?.trim();
  const table = rawTable ? resolveTableName(ctx.tables, rawTable) : null;
  const target = table?.value ?? ctx.current;
  if (!target) return null;
  // A sentence that named a table we could not find is a miss, not a reason
  // to silently use whatever was on screen.
  if (rawTable && !table) return null;

  const words = rawField.split(/\s+/).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  const fieldPhrase = words.join(' ') || rawField;
  const type = inferFieldType(rawField, fieldPhrase);
  // Strip a trailing type word from the name: "phone number column" is a
  // field called `phone`, not `phone_number`... unless that IS the name.
  const name = machineName(fieldPhrase);
  if (!name) return null;

  if (target.fields.some((field) => field.name === name)) {
    return {
      kind: 'unsupported',
      summary: `${target.displayName} already has a field called ${name}.`,
      confidence: 1,
      operations: [],
    };
  }

  return {
    kind: 'schema',
    summary: `Add a ${type} field "${titleCase(name)}" to ${target.displayName}.`,
    confidence: (table?.score ?? (ctx.current ? 0.85 : 0)) * 0.95 + 0.05,
    operations: [
      {
        kind: 'add-field',
        tableRef: target.name,
        field: { name, displayName: titleCase(name), type },
      },
    ],
  };
};

/** "add a customer called Northwind" / "new invoice with total 1200, status sent" */
const addRecord: Rule = (text, ctx) => {
  // No `\s*` before the trailing group: a greedy space-eater there would
  // consume the space that the group's own `\s+` needs, and the whole optional
  // clause would never match.
  // The keyword is captured, not merely consumed: the clause after "called"
  // means something different from the clause after "with", and this match is
  // the only place that distinction is still visible.
  const m =
    /^(?:add|create|new|insert)\s+(?:an|a)?\s*(?:new\s+)?(?:row|record|entry)?\s*(?:to|in|for)?\s*([a-z0-9_\- ]+?)(?:\s+(called|named|with|where)\s+(.+))?$/i.exec(
      text,
    );
  if (!m) return null;

  const rawTable = m[1]!.trim();
  const keyword = m[2]?.toLowerCase() ?? '';
  const remainder = m[3]?.trim() ?? '';
  const resolved = resolveTableName(ctx.tables, rawTable);
  const target = resolved?.value ?? null;
  if (!target) return null;

  const data: Record<string, unknown> = {};
  const unmatchedParts: string[] = [];

  // "called X [with ...]" — X names the row, anything after `with` is
  // field/value pairs. A bare "with ..." is all pairs.
  let namePart = '';
  let withPart = '';
  if (keyword === 'called' || keyword === 'named') {
    const split = /\s+with\s+/i.exec(remainder);
    namePart = split ? remainder.slice(0, split.index) : remainder;
    withPart = split ? remainder.slice(split.index + split[0].length) : '';
  } else if (keyword === 'with' || keyword === 'where') {
    withPart = remainder;
  }

  if (namePart.trim()) {
    // The name column in every pack we ship, falling back to the first text
    // field for a table someone built themselves.
    const nameField =
      target.fields.find((field) => field.name === 'name') ??
      target.fields.find((field) => field.name === 'title') ??
      target.fields.find((field) => field.type === 'text');
    if (nameField) data[nameField.name] = namePart.trim().replace(/^["']|["']$/g, '');
  }

  if (withPart.trim()) {
    // Split on a comma only when it is not a thousands separator. Splitting on
    // every comma turns "$1,250.50" into "$1" and "250.50", and quietly
    // records a hundred dollars.
    for (const clause of withPart.split(/,(?!\d)|\band\b/)) {
      const pair = /^\s*([a-z0-9_ ]+?)\s*(?:=|:|\s)\s*(.+?)\s*$/i.exec(clause);
      if (!pair) {
        if (clause.trim()) unmatchedParts.push(clause.trim());
        continue;
      }
      const field = resolveFieldName(target, pair[1]!);
      if (!field) {
        unmatchedParts.push(clause.trim());
        continue;
      }
      const value = coerceValue(pair[2]!, field.value.type);
      if (value === undefined) unmatchedParts.push(clause.trim());
      else data[field.value.name] = value;
    }
  }

  if (Object.keys(data).length === 0) return null;

  const label = Object.values(data)[0];
  return {
    kind: 'data',
    summary: `Add a row to ${target.displayName}${label ? ` — ${String(label)}` : ''}.`,
    confidence: resolved!.score * (unmatchedParts.length ? 0.7 : 0.95),
    operations: [{ kind: 'create-record', tableRef: target.name, data }],
    ...(unmatchedParts.length ? { unmatched: unmatchedParts.join(', ') } : {}),
  };
};

/** "create a table called suppliers with name, email, phone" */
const createTable: Rule = (text, ctx) => {
  const m = /^(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?table\s+(?:called|named)?\s*([a-z0-9_\- ]+?)\s*(?:\s+with\s+(.+))?$/i.exec(
    text,
  );
  if (!m) return null;

  const name = machineName(m[1]!);
  if (!name) return null;
  if (ctx.tables.some((table) => table.name === name)) {
    return {
      kind: 'unsupported',
      summary: `A table called ${name} already exists.`,
      confidence: 1,
      operations: [],
    };
  }

  const fieldPhrases = (m[2] ?? 'name')
    .split(/,|\band\b/)
    .map((part) => part.trim())
    .filter(Boolean);

  const fields = fieldPhrases.map((phrase) => {
    const fieldName = machineName(phrase);
    return {
      name: fieldName,
      displayName: titleCase(fieldName),
      type: inferFieldType(phrase, fieldName),
    };
  });
  // A table with no usable column names is a misread sentence.
  if (fields.every((field) => !field.name)) return null;

  return {
    kind: 'schema',
    summary: `Create a table "${titleCase(name)}" with ${fields.length} field(s): ${fields
      .map((f) => f.name)
      .join(', ')}.`,
    confidence: 0.9,
    operations: [
      {
        kind: 'create-table',
        table: { name, displayName: titleCase(name), fields: fields.filter((f) => f.name) },
      },
    ],
  };
};

/** "show invoices where status is sent" / "show overdue invoices" /
 *  "sort deals by value descending" */
const queryRule: Rule = (text, ctx) => {
  const m =
    /^(?:show|list|find|get|display|filter|search)\s+(?:me\s+)?(?:all\s+)?(.+?)$/i.exec(text) ??
    /^(?:sort|order)\s+(.+?)$/i.exec(text);
  if (!m) return null;

  let rest = m[1]!.trim();
  const filters: WorkspaceRecordFilter[] = [];
  let sort: WorkspaceRecordSort | null = null;
  let overdue = false;

  // "overdue" is a word about dates, not a field, so it is handled before the
  // table name is even resolved.
  if (/\boverdue\b|\blate\b|\bpast due\b/i.test(rest)) {
    overdue = true;
    rest = rest.replace(/\b(overdue|late|past due)\b/gi, ' ').trim();
  }

  let whereClause: string | null = null;
  const whereMatch = /\bwhere\s+(.+)$/i.exec(rest);
  if (whereMatch) {
    whereClause = whereMatch[1]!;
    rest = rest.slice(0, whereMatch.index).trim();
  }

  // Take the sort clause off before resolving the table, or "deals by value
  // descending" is looked up as a table name in its entirety and finds nothing.
  const sortMatch = /\b(?:sorted\s+by|sort\s+by|ordered\s+by|by)\s+([a-z0-9_ ]+?)(\s+(?:asc|ascending|desc|descending))?\s*$/i.exec(
    rest,
  );
  const sortClause = sortMatch ? sortMatch[0] : null;
  if (sortMatch) rest = rest.slice(0, sortMatch.index).trim();

  const resolvedTable = resolveTableName(ctx.tables, rest.replace(/\s+/g, ' ').trim());
  const target = resolvedTable?.value ?? ctx.current;
  if (!target) return null;

  if (sortMatch) {
    const field = resolveFieldName(target, sortMatch[1]!);
    if (field) {
      sort = {
        field: field.value.name,
        direction: /desc/i.test(sortMatch[2] ?? '') ? 'desc' : 'asc',
      };
    } else if (sortClause) {
      // Said "by something" and we could not find that column. Better to
      // report it than to silently drop the ordering they asked for.
      return null;
    }
  }

  if (whereClause) {
    for (const clause of whereClause.split(/\band\b/)) {
      const pair =
        /^\s*([a-z0-9_ ]+?)\s+(?:is\s+not|is|=|==|!=|>=|<=|>|<|contains)\s+(.+?)\s*$/i.exec(clause);
      if (!pair) continue;
      const field = resolveFieldName(target, pair[1]!);
      if (!field) continue;
      const opText = /is\s+not|!=/i.test(clause) ? 'neq' : /contains/i.test(clause) ? 'contains' : '=';
      const raw = pair[2]!.trim();
      const value = coerceValue(raw, field.value.type);
      filters.push({
        field: field.value.name,
        op: opText === '=' ? 'eq' : (opText as 'neq' | 'contains'),
        value: (value ?? raw) as never,
      });
    }
  }

  if (overdue) {
    // Overdue means: a due date in the past, and not already settled. Both
    // halves matter — a paid invoice with a past due date is not overdue.
    const dueField = target.fields.find(
      (field) => (field.config as { role?: string } | null)?.role === 'due-date',
    );
    if (dueField) {
      filters.push({ field: dueField.name, op: 'lt', value: new Date().toISOString().slice(0, 10) });
    }
    const statusField = target.fields.find(
      (field) => (field.config as { role?: string } | null)?.role === 'status',
    );
    if (statusField) {
      const settled = ['paid', 'void', 'cancelled', 'closed', 'done'];
      const options = ((statusField.config as { options?: string[] } | null)?.options ?? []).filter(
        (option) => !settled.includes(option),
      );
      if (options.length) {
        filters.push({ field: statusField.name, op: 'in', value: options as never });
      }
    }
    if (!dueField && !statusField) return null;
  }

  return {
    kind: 'query',
    summary: `Show ${target.displayName}${filters.length ? ` matching ${filters.length} condition(s)` : ''}${
      sort ? `, sorted by ${sort.field}` : ''
    }.`,
    confidence: (resolvedTable?.score ?? 0.8) * 0.95,
    operations: [],
    query: { tableRef: target.name, filters, sort, search: null },
  };
};

/** "group deals by stage" — a view change rather than a query. */
const groupRule: Rule = (text, ctx) => {
  const m = /^(?:group|board)\s+(.+?)\s+by\s+([a-z0-9_ ]+?)$/i.exec(text);
  if (!m) return null;
  const resolved = resolveTableName(ctx.tables, m[1]!);
  const target = resolved?.value ?? ctx.current;
  if (!target) return null;
  const field = resolveFieldName(target, m[2]!);
  if (!field) return null;

  return {
    kind: 'view',
    summary: `Group ${target.displayName} by ${field.value.displayName}.`,
    confidence: (resolved?.score ?? 0.8) * 0.9,
    operations: [],
    query: { tableRef: target.name, filters: [], sort: null, search: null },
  };
};

/** People put the table on either side of the target:
 *   "rename phone to mobile on customers"
 *   "rename the phone column on customers to mobile"
 * Both are ordinary phrasings, so both are matched rather than one being
 * declared correct. */
const renameFieldRule: Rule = (text, ctx) => {
  const m = /^rename\s+(?:the\s+)?(.+?)\s+to\s+(.+?)$/i.exec(text);
  if (!m) return null;

  let fieldPhrase = m[1]!.trim();
  let toPhrase = m[2]!.trim();
  let rawTable: string | undefined;

  // "... on customers" trailing the new name.
  const trailing = /^(.+?)\s+(?:on|in)\s+(.+?)$/i.exec(toPhrase);
  if (trailing) {
    toPhrase = trailing[1]!.trim();
    rawTable = trailing[2]!.trim();
  }
  // "... the phone column on customers" before the `to`.
  const leading = /^(.+?)\s+(?:on|in)\s+(.+?)$/i.exec(fieldPhrase);
  if (!rawTable && leading) {
    fieldPhrase = leading[1]!.trim();
    rawTable = leading[2]!.trim();
  }
  fieldPhrase = fieldPhrase.replace(/\s+(?:column|field)$/i, '').trim();
  toPhrase = toPhrase.replace(/\s+(?:column|field)$/i, '').trim();

  const table = rawTable ? resolveTableName(ctx.tables, rawTable) : null;
  if (rawTable && !table) return null;
  const target = table?.value ?? ctx.current;
  if (!target) return null;

  const field = resolveFieldName(target, fieldPhrase);
  if (!field) return null;
  const to = machineName(toPhrase);
  if (!to) return null;

  return {
    kind: 'schema',
    summary: `Rename "${field.value.displayName}" to "${titleCase(to)}" on ${target.displayName}. Values are carried across.`,
    confidence: (table?.score ?? 0.85) * field.score * 0.95,
    // Rename is not a ProposalOperation: it migrates existing rows, which the
    // proposal engine's inverse-per-operation model does not cover. The plan
    // is named here so the caller can apply it directly, impact shown first.
    operations: [],
    schemaChange: { kind: 'rename', table: target.name, field: field.value.name, to },
  };
};

/** "delete the fax column" / "remove fax from customers" */
const removeFieldRule: Rule = (text, ctx) => {
  const m = /^(?:delete|remove|drop)\s+(?:the\s+)?(.+?)(?:\s+(?:column|field))?(?:\s+(?:from|on|in)\s+(.+?))?$/i.exec(
    text,
  );
  if (!m) return null;

  const rawTable = m[2]?.trim();
  const table = rawTable ? resolveTableName(ctx.tables, rawTable) : null;
  if (rawTable && !table) return null;
  const target = table?.value ?? ctx.current;
  if (!target) return null;

  const field = resolveFieldName(target, m[1]!);
  if (!field) return null;

  return {
    kind: 'schema',
    summary: `Remove "${field.value.displayName}" from ${target.displayName}. Its values are kept, so this can be undone.`,
    confidence: (table?.score ?? 0.85) * field.score * 0.9,
    operations: [],
    schemaChange: { kind: 'remove', table: target.name, field: field.value.name },
  };
};

/** Order matters: the most specific grammar first, so "create a table called
 * X" is not eaten by the generic "create a <row>" rule. */
const RULES: Rule[] = [
  createTable,
  renameFieldRule,
  removeFieldRule,
  addField,
  addRecord,
  groupRule,
  queryRule,
];

// --- Entry point ----------------------------------------------------------

export function interpretIntent(
  recordsDb: RecordsDb,
  text: string,
  options: { tableRef?: string } = {},
): InterpretIntentResponse {
  const trimmed = text.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  const tables = listTables(recordsDb);
  const current = options.tableRef
    ? (tables.find((table) => table.id === options.tableRef || table.name === options.tableRef) ?? null)
    : null;

  if (!trimmed) {
    return unsupported('Type what you want to change or find.');
  }

  for (const rule of RULES) {
    const match = rule(trimmed, { tables, current });
    if (!match) continue;
    return {
      kind: match.kind,
      summary: match.summary,
      confidence: Math.min(1, Math.max(0, match.confidence)),
      operations: match.operations,
      preview: null,
      query: match.query ?? null,
      unmatched: match.unmatched ?? null,
      schemaChange: match.schemaChange ?? null,
      suggestions: match.confidence < 0.75 ? exampleStrings() : [],
    };
  }

  return unsupported(
    `Not sure what to do with "${trimmed}". The assistant can handle this — ask it in chat, and it will propose the change for you to approve.`,
  );
}

function unsupported(summary: string): InterpretIntentResponse {
  return {
    kind: 'unsupported',
    summary,
    confidence: 0,
    operations: [],
    preview: null,
    query: null,
    unmatched: null,
    schemaChange: null,
    suggestions: exampleStrings(),
  };
}

function exampleStrings(): string[] {
  return INTENT_EXAMPLES.map((entry) => entry.example);
}
