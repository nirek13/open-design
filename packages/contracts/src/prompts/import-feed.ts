/** Prompts that turn workspace tables (imported or already there) into an app. */

export interface TableAppColumn {
  header: string;
  fieldName: string;
  type: string;
}

export interface TableAppTarget {
  tableName: string;
  displayName: string;
  columns: TableAppColumn[];
}

function tableColumnLines(columns: readonly TableAppColumn[]): string {
  return columns
    .map((column) => `- ${column.header} (\`${column.fieldName}\`, ${column.type})`)
    .join('\n');
}

function namedTables(tables: readonly TableAppTarget[]): TableAppTarget[] {
  return tables.filter((table) => table.tableName.trim());
}

/** Build a data-connected HTML app against one or more workspace tables.
 *
 * `existing` is the "use tables you already have" path: the agent must not
 * invent a parallel schema. `imported` is the post-magic-import path. */
export function composeTableAppPrompt(input: {
  tables: readonly TableAppTarget[];
  sourceUrl?: string;
  request?: string;
  origin?: 'imported' | 'existing';
}): string {
  const tables = namedTables(input.tables);
  const origin = input.origin ?? (tables.length > 1 ? 'existing' : 'imported');
  const request = input.request?.trim();
  const source = input.sourceUrl?.trim();
  const names = tables.map((table) => `\`${table.tableName}\``);
  const nameList = names.join(', ');
  const lead =
    tables.length === 0
      ? origin === 'existing'
        ? 'Build a custom interface over existing workspace tables.'
        : 'Build a custom interface for the imported workspace data.'
      : tables.length === 1
        ? origin === 'existing'
          ? `Build a custom interface for the existing "${tables[0]!.displayName}" workspace table (\`${tables[0]!.tableName}\`). Reuse this table — do not create a parallel one.`
          : `Build a custom interface for the imported "${tables[0]!.displayName}" data (workspace table \`${tables[0]!.tableName}\`).`
        : `Build a custom interface over these existing workspace tables: ${nameList}. Reuse them — do not create parallel tables.`;
  const describeQuery = tables
    .map((table) => `\`await api.describe('${table.tableName}')\` and \`await api.query('${table.tableName}', { limit: 200, sort, filters })\``)
    .join('; then ');
  const scopeFlags = tables
    .map((table) => `\`--scope ${table.tableName}:read\` or \`--scope ${table.tableName}:write\``)
    .join(', ');
  const columnBlock =
    tables.length === 0
      ? '- (see od.describe)'
      : tables
          .map((table) => {
            const heading = tables.length > 1 ? `\`${table.tableName}\` (${table.displayName}):` : 'Columns:';
            return `${heading}\n${tableColumnLines(table.columns) || '- (see od.describe)'}`;
          })
          .join('\n\n');

  return [
    request ? `${request.replace(/[.]*$/, '')}.\n\n${lead}` : lead,
    '',
    'This is a data app, not a marketing page. Write a single HTML file (`index.html`) that:',
    '',
    `1. The project preview injects \`window.od\` (also \`od\`) before your script. Start with \`const api = window.od; if (!api) { document.body.textContent = 'Open this file in the workspace preview.'; return; }\` then ${describeQuery || '`await api.scopes()`'}. Never fetch \`/api\` yourself.`,
    '2. Feels purpose-built for this dataset: search, filters on the useful columns, a scannable list or cards, and a detail view for a selected row.',
    '3. Handles empty and loading states. Dates should be readable. Long text should clamp with an expand.',
    `4. Ask, via \`<question-form id="org_data_write">\`, whether this app may read ${nameList || 'the named workspace tables'} (and write, if the interface saves or edits rows). After they agree, publish with ${scopeFlags || '`--scope <table>:read` or `--scope <table>:write`'}. Never assume write access. Do not invent auth or mock data.`,
    '',
    columnBlock,
    source ? `\nSource feed: ${source}` : '',
    '',
    'After the HTML works in preview, stop unless they granted data access above. If they did, publish with those `--scope` flags. Otherwise the person will be asked again when they add it to the workspace.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function composeImportRefreshPrompt(input: { url: string; tableName: string }): string {
  const url = input.url.trim();
  const table = input.tableName.trim();
  return [
    'Refresh the imported public data feed. This run is unattended — do not ask questions.',
    '',
    'Re-import into the existing table (do not create a new one):',
    '',
    `"$OD_NODE_BIN" "$OD_BIN" tools data import-url --url ${JSON.stringify(url)} --table ${table}`,
    '',
    'The table already exists. Matching unique keys should update in place; rows that disappeared from the feed should be removed. After it finishes, reply with imported / updated / removed / skipped counts only.',
  ].join('\n');
}

export function composeImportAppPrompt(input: {
  tableName: string;
  displayName: string;
  columns: Array<{ header: string; fieldName: string; type: string }>;
  sourceUrl?: string;
  /** What the person asked the interface to do. */
  request?: string;
}): string {
  return composeTableAppPrompt({
    tables: [
      {
        tableName: input.tableName,
        displayName: input.displayName,
        columns: input.columns,
      },
    ],
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.request ? { request: input.request } : {}),
    origin: 'imported',
  });
}
