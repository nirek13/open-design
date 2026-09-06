import { describe, expect, it } from 'vitest';
import {
  composeImportAppPrompt,
  composeImportRefreshPrompt,
  composeTableAppPrompt,
} from '../src/prompts/import-feed.js';

describe('import-feed prompts', () => {
  it('tells the refresh job to reuse the existing table', () => {
    const prompt = composeImportRefreshPrompt({
      url: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
      tableName: 'new_tender_notice',
    });
    expect(prompt).toContain('tools data import-url');
    expect(prompt).toContain('new_tender_notice');
    expect(prompt).toContain('canadabuys.canada.ca');
    expect(prompt).toContain('do not create a new one');
  });

  it('tells the app builder to query the imported table through od', () => {
    const prompt = composeImportAppPrompt({
      tableName: 'new_tender_notice',
      displayName: 'New tender notice',
      columns: [{ header: 'Title (English)', fieldName: 'title_eng', type: 'text' }],
      sourceUrl: 'https://canadabuys.canada.ca/opendata/pub/tenders.csv',
    });
    expect(prompt).toContain("api.query('new_tender_notice'");
    expect(prompt).toContain('title_eng');
    expect(prompt).toContain('index.html');
    expect(prompt).toContain('org_data_write');
    expect(prompt).toContain('--scope new_tender_notice:read');
  });

  it('leads with the person\'s own request when they wrote one', () => {
    const prompt = composeImportAppPrompt({
      tableName: 'new_tender_notice',
      displayName: 'New tender notice',
      columns: [{ header: 'Title', fieldName: 'title_eng', type: 'text' }],
      request: 'A board of open tenders grouped by closing week',
    });
    expect(prompt).toContain('A board of open tenders grouped by closing week');
    expect(prompt.indexOf('A board of open tenders')).toBeLessThan(prompt.indexOf('api.query'));
  });

  it('tells the app builder to reuse existing workspace tables instead of inventing new ones', () => {
    const prompt = composeTableAppPrompt({
      origin: 'existing',
      tables: [
        {
          tableName: 'invoices',
          displayName: 'Invoices',
          columns: [{ header: 'Number', fieldName: 'number', type: 'text' }],
        },
        {
          tableName: 'customers',
          displayName: 'Customers',
          columns: [{ header: 'Name', fieldName: 'name', type: 'text' }],
        },
      ],
    });
    expect(prompt).toContain('existing workspace tables');
    expect(prompt).toContain('do not create parallel tables');
    expect(prompt).toContain("api.query('invoices'");
    expect(prompt).toContain("api.query('customers'");
    expect(prompt).toContain('--scope invoices:read');
    expect(prompt).toContain('--scope customers:read');
  });
});
