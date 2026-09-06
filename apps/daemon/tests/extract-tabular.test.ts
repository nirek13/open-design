import { describe, expect, it } from 'vitest';

import { extractTabularFromHtml } from '../src/workspace-data/extract-tabular.js';

describe('extractTabularFromHtml', () => {
  it('reads repeating product cards when there is no <table>', () => {
    const html = `
      <div class="card"><h3>Walnut chair</h3><span class="price">$120</span><a href="/p/1">View</a><p>In stock</p></div>
      <div class="card"><h3>Oak table</h3><span class="price">$340</span><a href="/p/2">View</a><p>Made to order</p></div>
      <div class="card"><h3>Pine stool</h3><span class="price">$45</span><a href="/p/3">View</a><p>In stock</p></div>
    `;
    const csv = extractTabularFromHtml(html);
    expect(csv).toBeTruthy();
    expect(csv).toContain('Walnut chair');
    expect(csv).toContain('Oak table');
    expect(csv).toMatch(/120/);
  });

  it('reads a definition list as name/value rows', () => {
    const html = `
      <dl>
        <dt>Founded</dt><dd>2014</dd>
        <dt>HQ</dt><dd>Lisbon</dd>
        <dt>Employees</dt><dd>40</dd>
      </dl>
    `;
    const csv = extractTabularFromHtml(html);
    expect(csv).toContain('Founded,2014');
    expect(csv).toContain('HQ,Lisbon');
  });

  it('reads JSON-LD ItemList payloads', () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'ItemList',
        itemListElement: [
          { name: 'Ada', role: 'Owner' },
          { name: 'Bea', role: 'Member' },
        ],
      })}</script>
    `;
    const csv = extractTabularFromHtml(html);
    expect(csv).toContain('Ada');
    expect(csv).toContain('Bea');
    expect(csv).toContain('Owner');
  });

  it('reads a window-assigned JSON array when the markup is an empty SPA shell', () => {
    const html = `
      <html><body>
        <div id="root"></div>
        <script>window.__DIRECTORY__ = ${JSON.stringify({
          hits: [
            { name: 'DoorDash', batch: 'Summer 2013', one_liner: 'Restaurant delivery.' },
            { name: 'Airbnb', batch: 'Winter 2009', one_liner: 'Book unique homes.' },
          ],
        })};</script>
      </body></html>
    `;
    const csv = extractTabularFromHtml(html);
    expect(csv).toContain('DoorDash');
    expect(csv).toContain('Airbnb');
    expect(csv).toContain('Restaurant delivery.');
  });

  it('reads an Inertia data-page payload of records', () => {
    const page = {
      component: 'Companies/Index',
      props: {
        companies: [
          { name: 'Stripe', batch: 'S09' },
          { name: 'Dropbox', batch: 'S07' },
        ],
      },
    };
    const html = `<div data-page="${JSON.stringify(page).replace(/"/g, '&quot;')}"></div>`;
    const csv = extractTabularFromHtml(html);
    expect(csv).toContain('Stripe');
    expect(csv).toContain('Dropbox');
  });
});
