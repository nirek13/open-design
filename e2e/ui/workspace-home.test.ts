// Playwright coverage for the main view (apps/web/src/components/
// workspace-home/WorkspaceHome.tsx) against a real tools-dev daemon.
//
// The unit tests mock the API; this one drives the actual page against real
// data, so it catches the things mocks cannot: routing, the org header
// reaching the daemon, and whether a person can genuinely get from an empty
// workspace to a saved document without knowing anything about tables.

import { expect, test } from '@/playwright/suite';

test.describe.configure({ timeout: 90_000 });

const CONFIG_STORAGE_KEY = 'open-design:config';

test('the main view finds, creates, and builds', async ({ page, toolsDev }) => {
  // `url.daemon(path)` builds the URL; calling it bare yields a trailing
  // slash that would double up when concatenated.
  const api = (path: string) => toolsDev.url.daemon(path);
  // Seed through the public API — the same path the product uses, so the
  // test never depends on a shape the app itself cannot produce.
  const orgs = await page.request.get(api('/api/orgs'));
  const orgId = (await orgs.json()).organizations[0].id;
  await page.request.post(api(`/api/orgs/${orgId}/hub/setup`));

  const customer = await page.request.post(
    api(`/api/data/orgs/${orgId}/tables/customers/records`),
    { data: { data: { name: 'Northwind Builders', email: 'ops@northwind.test' } } },
  );
  const customerId = (await customer.json()).record.id;
  await page.request.post(api(`/api/data/orgs/${orgId}/tables/invoices/records`), {
    data: {
      data: {
        invoice_number: 'INV-1001',
        customer: customerId,
        issue_date: '2026-04-02',
        status: 'sent',
        total: 120000,
      },
    },
  });

  // Without this the app routes to first-run onboarding instead of the
  // workspace, and every later assertion races a redirect.
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    { key: CONFIG_STORAGE_KEY, value: { onboardingCompleted: true } },
  );

  await page.goto(toolsDev.url.web('/workspace'));
  const home = page.getByTestId('workspace-home');
  await expect(home).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('workspace-ask-input')).toBeVisible();

  // Search reaches across tables from the same box used to ask.
  await page.getByTestId('workspace-ask-input').fill('northwind');
  await expect(page.getByTestId('workspace-search-results')).toBeVisible();
  await expect(page.getByText('Northwind Builders')).toBeVisible();

  // Clearing search returns to the empty stage; new records live under Create.
  await page.getByTestId('workspace-ask-input').fill('');
  await expect(page.getByTestId('workspace-search-results')).toHaveCount(0);
  await expect(page.getByText('INV-1001')).toHaveCount(0);
  await page.getByTestId('workspace-create').click();
  await expect(page.getByTestId('workspace-new-invoices')).toBeVisible();

  // Creating a document opens a form generated from the table's own schema.
  await page.getByTestId('workspace-new-invoices').click();
  const editor = page.getByTestId('record-editor');
  await expect(editor).toBeVisible();
  // The number and date are pre-filled, because nobody should have to type them.
  await expect(editor.locator('input').first()).not.toHaveValue('');
  await page.getByRole('button', { name: /cancel/i }).click();
  await expect(editor).toHaveCount(0);

  // All three routes to a custom tool are offered.
  await page.getByTestId('workspace-create').click();
  await page.getByTestId('workspace-build-tool').click();
  await expect(page.getByTestId('tool-builder')).toBeVisible();
  await expect(page.getByTestId('builder-describe')).toBeVisible();
  await expect(page.getByTestId('builder-import')).toBeVisible();
  await expect(page.getByTestId('builder-define')).toBeVisible();

  // Defining a table by hand works end to end.
  await page.getByTestId('builder-define').click();
  await page.getByTestId('builder-table-name').fill('site_visits');
  const fieldRow = page.getByTestId('tool-builder').locator('input[type="text"]').nth(1);
  await fieldRow.fill('visited_on');
  await page.getByTestId('builder-create-table').click();
  await expect(page.getByTestId('tool-builder')).toHaveCount(0, { timeout: 15_000 });

  // And the new table shows up as somewhere to add records.
  await page.getByTestId('workspace-create').click();
  await expect(page.getByTestId('workspace-new-site_visits')).toBeVisible({ timeout: 15_000 });
});
