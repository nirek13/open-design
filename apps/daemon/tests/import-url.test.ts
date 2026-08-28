import { describe, expect, it } from 'vitest';

import {
  htmlTableToCsv,
  jsonToCsv,
  rewriteImportUrl,
  rowsToCsv,
  fetchImportSource,
} from '../src/workspace-data/import-url.js';
import { buildImportPlan } from '../src/workspace-data/import.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('rewriteImportUrl', () => {
  it('turns a Google Sheets edit link into the CSV export', () => {
    const { href, kind } = rewriteImportUrl(
      'https://docs.google.com/spreadsheets/d/1AbC_def/edit#gid=42',
    );
    expect(kind).toBe('google-sheets');
    expect(href).toBe('https://docs.google.com/spreadsheets/d/1AbC_def/export?format=csv&gid=42');
  });

  it('keeps an already-exported sheet URL', () => {
    const href =
      'https://docs.google.com/spreadsheets/d/1AbC_def/export?format=csv&gid=0';
    expect(rewriteImportUrl(href).href).toBe(href);
  });

  it('rejects a non-http URL', () => {
    expect(() => rewriteImportUrl('file:///etc/passwd')).toThrow(/http/);
  });
});

describe('jsonToCsv', () => {
  it('flattens an array of objects, including nested JSON cells', () => {
    const csv = jsonToCsv(
      JSON.stringify([
        { name: 'Ada', amount: 12.5, tags: ['a', 'b'] },
        { name: 'Bob', amount: 3 },
      ]),
    );
    expect(csv).toContain('name,amount,tags');
    expect(csv).toContain('Ada,12.5,"[""a"",""b""]"');
    expect(csv).toContain('Bob,3');
  });

  it('unwraps a {records: [...]} envelope', () => {
    const csv = jsonToCsv(JSON.stringify({ records: [{ sku: 'A-1', qty: 4 }] }));
    expect(csv).toBe(rowsToCsv([['sku', 'qty'], ['A-1', '4']]));
  });
});

describe('htmlTableToCsv', () => {
  it('reads the largest table, not a tiny nav table', () => {
    const html = `
      <table><tr><th>x</th></tr><tr><td>y</td></tr></table>
      <table>
        <tr><th>Customer</th><th>Total</th></tr>
        <tr><td>Acme</td><td>$12.00</td></tr>
        <tr><td>Beta</td><td>$3.50</td></tr>
      </table>`;
    const csv = htmlTableToCsv(html);
    expect(csv).toContain('Customer,Total');
    expect(csv).toContain('Acme,$12.00');
    expect(csv).not.toMatch(/^x,/m);
  });
});

describe('fetchImportSource', () => {
  function mockFetch(body: string, contentType: string, status = 200) {
    return async (url: string): Promise<Response> =>
      new Response(body, {
        status,
        headers: { 'content-type': contentType },
        url,
      } as ResponseInit);
  }

  it('rewrites a Google Sheets edit URL before fetching', async () => {
    const seen: string[] = [];
    const source = await fetchImportSource(
      'https://docs.google.com/spreadsheets/d/1AbC_def/edit#gid=9',
      async (url) => {
        seen.push(url);
        return new Response('Name,Qty\nWidget,2\n', {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        });
      },
    );
    expect(seen).toEqual(['https://docs.google.com/spreadsheets/d/1AbC_def/export?format=csv&gid=9']);
    expect(source.kind).toBe('google-sheets');
    expect(source.content).toContain('Widget,2');
  });

  it('flattens a JSON array of objects', async () => {
    const source = await fetchImportSource(
      'https://example.com/customers.json',
      mockFetch(JSON.stringify([{ name: 'Ada', city: 'London' }]), 'application/json'),
    );
    expect(source.kind).toBe('json');
    expect(source.content).toBe(rowsToCsv([['name', 'city'], ['Ada', 'London']]));
  });

  it('reads the largest HTML table on a page', async () => {
    const source = await fetchImportSource(
      'https://example.com/report',
      mockFetch(
        '<table><tr><th>Sku</th><th>Qty</th></tr><tr><td>A-1</td><td>4</td></tr></table>',
        'text/html',
      ),
    );
    expect(source.kind).toBe('html-table');
    expect(source.content).toContain('Sku,Qty');
    expect(source.content).toContain('A-1,4');
  });

  it('turns repeating HTML cards into rows when the page has no table', async () => {
    const source = await fetchImportSource(
      'https://example.com/catalog',
      mockFetch(
        `<div class="item"><h3>Lamp</h3><span class="price">$40</span><a href="/p/1">Buy</a></div>
         <div class="item"><h3>Vase</h3><span class="price">$22</span><a href="/p/2">Buy</a></div>
         <div class="item"><h3>Bowl</h3><span class="price">$18</span><a href="/p/3">Buy</a></div>`,
        'text/html',
      ),
    );
    expect(source.kind).toBe('html-table');
    expect(source.content).toContain('Lamp');
    expect(source.content).toContain('Vase');
  });

  const PROSE_PAGE = `<html><head><title>Team</title></head><body>
    <p>Ada Lovelace leads engineering in London.</p>
    <p>Grace Hopper leads platform in New York.</p>
  </body></html>`;

  it('cannot invent rows from unstructured prose without AI', async () => {
    await expect(
      fetchImportSource('https://example.com/team', mockFetch(PROSE_PAGE, 'text/html'), null),
    ).rejects.toThrow(/no rows could be read/);
  });

  it('asks AI to turn unstructured prose into rows', async () => {
    const source = await fetchImportSource(
      'https://example.com/team',
      mockFetch(PROSE_PAGE, 'text/html'),
      async () => ({
        tableName: 'team',
        rows: [
          ['name', 'role', 'city'],
          ['Ada Lovelace', 'engineering', 'London'],
          ['Grace Hopper', 'platform', 'New York'],
        ],
      }),
    );
    expect(source.kind).toBe('ai');
    expect(source.fileName).toBe('team.csv');
    expect(source.content).toContain('Ada Lovelace,engineering,London');
    expect(source.content).toContain('Grace Hopper,platform,New York');
  });

  it('refuses a non-public status', async () => {
    await expect(
      fetchImportSource('https://example.com/secret.csv', mockFetch('nope', 'text/csv', 403)),
    ).rejects.toThrow(/publicly readable/);
  });

  it('reads a UTF-8 BOM CSV served as octet-stream from an open-data dump', async () => {
    const csv =
      '\uFEFF"title-titre-eng","referenceNumber-numeroReference"\n"NPP support","cb-1"\n';
    const source = await fetchImportSource(
      'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
      mockFetch(csv, 'application/octet-stream'),
    );
    expect(source.kind).toBe('csv');
    expect(source.content.startsWith('\uFEFF')).toBe(false);
    expect(source.fileName).toBe('newTenderNotice-nouvelAvisAppelOffres.csv');
    expect(source.content).toContain('title-titre-eng');
    expect(rewriteImportUrl(
      'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
    ).kind).toBe('csv');
  });
});

describe('magic import plan from normalized JSON', () => {
  it('feeds jsonToCsv into the existing spreadsheet planner', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-import-url-'));
    const manager = new WorkspaceDbManager(dir);
    const orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    try {
      const content = jsonToCsv(
        JSON.stringify([
          { customer: 'Acme', total: '$10.00', date: '2026-01-02' },
          { customer: 'Beta', total: '$4.50', date: '2026-01-03' },
        ]),
      );
      expect(content).toBeTruthy();
      const plan = buildImportPlan(manager.openWorkspace(orgId), {
        content: content!,
        fileName: 'invoices.json',
      });
      expect(plan.rowCount).toBe(2);
      expect(plan.columns.map((c) => c.fieldName)).toEqual(['customer', 'total', 'date']);
      expect(plan.columns.find((c) => c.fieldName === 'total')?.type).toBe('money');
      expect(plan.columns.find((c) => c.fieldName === 'date')?.type).toBe('date');
    } finally {
      manager.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
