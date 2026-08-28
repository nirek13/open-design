/** Prompts that turn an imported public feed into an app or a refresh job. */

export function composeImportRefreshPrompt(input: { url: string; tableName: string }): string {
  const url = input.url.trim();
  const table = input.tableName.trim();
  return [
    'Refresh the imported public data feed. This run is unattended — do not ask questions.',
    '',
    'Re-import into the existing table (do not create a new one):',
    '',
    `"$OD_NODE_BIN" "$OD_BIN" tools erp import-url --url ${JSON.stringify(url)} --table ${table}`,
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
  const columns = input.columns
    .map((column) => `- ${column.header} (\`${column.fieldName}\`, ${column.type})`)
    .join('\n');
  const source = input.sourceUrl?.trim();
  const request = input.request?.trim();
  return [
    request
      ? `Build this custom interface for the imported "${input.displayName}" data (workspace table \`${input.tableName}\`):\n\n${request}`
      : `Build a custom interface for the imported "${input.displayName}" data (workspace table \`${input.tableName}\`).`,
    '',
    'This is a data app, not a marketing page. Write a single HTML file (`index.html`) that:',
    '',
    `1. The project preview injects \`window.od\` (also \`od\`) before your script. Start with \`const api = window.od; if (!api) { document.body.textContent = 'Open this file in the workspace preview.'; return; }\` then \`await api.describe('${input.tableName}')\` and \`await api.query('${input.tableName}', { limit: 200, sort, filters })\`. Never fetch \`/api\` yourself.`,
    '2. Feels purpose-built for this dataset: search, filters on the useful columns, a scannable list or cards, and a detail view for a selected row.',
    '3. Handles empty and loading states. Dates should be readable. Long text should clamp with an expand.',
    `4. Ask, via \`<question-form id="org_data_write">\`, whether this app may read workspace table \`${input.tableName}\` (and write, if the interface saves or edits rows). After they agree, publish with \`--scope ${input.tableName}:read\` or \`--scope ${input.tableName}:write\`. Never assume write access. Do not invent auth or mock data.`,
    '',
    'Columns:',
    columns || '- (see od.describe)',
    source ? `\nSource feed: ${source}` : '',
    '',
    'After the HTML works in preview, stop unless they granted data access above. If they did, publish with those `--scope` flags. Otherwise the person will be asked again when they add it to the workspace.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
