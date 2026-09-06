import { describe, expect, it } from 'vitest';

import {
  fetchAlgoliaTable,
  parseAlgoliaSearchConfig,
} from '../src/workspace-data/discover-page-data.js';

const ALGOLIA_KEY = Buffer.from(
  `${'a'.repeat(64)}restrictIndices=YCCompany_production%2CYCCompany_By_Launch_Date_production&tagFilters=%5B%22ycdc_public%22%5D`,
).toString('base64');

const YC_SHELL = `<!DOCTYPE html><html><head>
<title>The YC Startup Directory | Y Combinator</title>
<script>window.AlgoliaOpts = {"app":"45BWZJ1SGC","key":"${ALGOLIA_KEY}"};</script>
</head>
<body class="ycdc2 companies index">
<div data-page="{&quot;component&quot;:&quot;ycdc_new/pages/Companies/IndexPage&quot;,&quot;props&quot;:{&quot;env&quot;:&quot;production&quot;,&quot;currentBatch&quot;:&quot;Summer 2026&quot;}}" id="root"></div>
</body></html>`;

describe('parseAlgoliaSearchConfig', () => {
  it('reads window.AlgoliaOpts and index names from a secured search key', () => {
    const config = parseAlgoliaSearchConfig(YC_SHELL);
    expect(config).toEqual({
      appId: '45BWZJ1SGC',
      apiKey: ALGOLIA_KEY,
      indexes: ['YCCompany_production', 'YCCompany_By_Launch_Date_production'],
    });
  });

  it('reads algoliasearch("app", "key") plus an indexName field', () => {
    const html = `
      <script>
        const client = algoliasearch("APPID99999", "search-only-key-value");
        instantsearch({ indexName: "Products_production" });
      </script>`;
    expect(parseAlgoliaSearchConfig(html)).toEqual({
      appId: 'APPID99999',
      apiKey: 'search-only-key-value',
      indexes: ['Products_production'],
    });
  });
});

describe('fetchAlgoliaTable', () => {
  it('queries the public search index and flattens hits into rows', async () => {
    const seen: string[] = [];
    const rows = await fetchAlgoliaTable(YC_SHELL, async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Algolia-Application-Id')).toBe('45BWZJ1SGC');
      expect(headers.get('X-Algolia-API-Key')).toBe(ALGOLIA_KEY);
      if (url.includes('YCCompany_By_Launch_Date')) {
        return new Response(JSON.stringify({ hits: [], nbHits: 0, nbPages: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          hits: [
            {
              name: 'DoorDash',
              batch: 'Summer 2013',
              one_liner: 'Restaurant delivery.',
              website: 'http://doordash.com',
              tags: ['Marketplace', 'E-commerce'],
              _highlightResult: { name: { value: '<em>DoorDash</em>' } },
            },
            {
              name: 'Airbnb',
              batch: 'Winter 2009',
              one_liner: 'Book unique homes.',
              website: 'http://airbnb.com',
              tags: ['Marketplace'],
            },
          ],
          nbHits: 2,
          nbPages: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    expect(seen.some((entry) => entry.includes('/indexes/YCCompany_production/query'))).toBe(true);
    expect(rows).toBeTruthy();
    const header = rows![0] ?? [];
    expect(header).toContain('name');
    expect(header).not.toContain('_highlightResult');
    const names = rows!.map((row) => row[header.indexOf('name')]);
    expect(names).toContain('DoorDash');
    expect(names).toContain('Airbnb');
    const tagsCol = header.indexOf('tags');
    expect(rows!.some((row) => /Marketplace/.test(row[tagsCol] ?? ''))).toBe(true);
  });
});
