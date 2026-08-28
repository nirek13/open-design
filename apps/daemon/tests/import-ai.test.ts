import { describe, expect, it } from 'vitest';

import { pageHtmlToText, rowsFromAiJson } from '../src/workspace-data/import-ai.js';

describe('pageHtmlToText', () => {
  it('keeps visible copy and drops scripts', () => {
    const text = pageHtmlToText(`
      <html><head><title>Team</title><script>window.track()</script></head>
      <body><h1>People</h1><p>Ada leads engineering.</p></body></html>
    `);
    expect(text).toContain('Team');
    expect(text).toContain('Ada leads engineering.');
    expect(text).not.toContain('window.track');
  });
});

describe('rowsFromAiJson', () => {
  it('reads a fenced JSON table', () => {
    const result = rowsFromAiJson(`
      here you go
      \`\`\`json
      {"table":"team","rows":[{"name":"Ada","role":"eng"}]}
      \`\`\`
    `);
    expect(result?.tableName).toBe('team');
    expect(result?.rows).toEqual([
      ['name', 'role'],
      ['Ada', 'eng'],
    ]);
  });

  it('returns null when the model found nothing', () => {
    expect(rowsFromAiJson('{"table":"","rows":[]}')).toBeNull();
  });
});
