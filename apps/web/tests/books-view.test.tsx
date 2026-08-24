// @vitest-environment jsdom

// The books. What a person must be able to see: whether the ledger is
// consistent, what was posted, and that a posted entry cannot be edited away.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BooksView } from '../src/components/books/BooksView';
import { I18nProvider } from '../src/i18n';
import { OrgProvider } from '../src/org/OrgContext';
import * as registry from '../src/providers/registry';

const ORG = {
  id: 'ws-1',
  name: 'Northwind',
  createdBy: 'wsm-1',
  createdAt: 1,
  updatedAt: 1,
  role: 'owner' as const,
  memberCount: 1,
};

const ACCOUNTS = [
  {
    id: 'acc-ar',
    orgId: 'ws-1',
    code: '1100',
    name: 'Accounts Receivable',
    type: 'asset' as const,
    currency: 'USD',
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'acc-rev',
    orgId: 'ws-1',
    code: '4000',
    name: 'Sales Revenue',
    type: 'revenue' as const,
    currency: 'USD',
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  },
];

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'je-1',
    orgId: 'ws-1',
    number: 1,
    date: '2026-06-01',
    memo: 'Invoice INV-1001',
    currency: 'USD',
    status: 'posted' as const,
    source: { kind: 'invoice' as const, recordId: 'rec-1' },
    reversedByEntryId: null,
    reversesEntryId: null,
    postedAt: 2,
    postedBy: 'wsm-1',
    createdBy: 'wsm-1',
    createdAt: 1,
    updatedAt: 2,
    lines: [
      { id: 'jl-1', entryId: 'je-1', accountId: 'acc-ar', direction: 'debit' as const, amount: 125000, memo: null, position: 0 },
      { id: 'jl-2', entryId: 'je-1', accountId: 'acc-rev', direction: 'credit' as const, amount: 125000, memo: null, position: 1 },
    ],
    ...overrides,
  };
}

const BALANCED = {
  currency: 'USD',
  asOf: '2026-06-30',
  rows: [
    { accountId: 'acc-ar', code: '1100', name: 'Accounts Receivable', type: 'asset' as const, debit: 125000, credit: 0, balance: 125000 },
    { accountId: 'acc-rev', code: '4000', name: 'Sales Revenue', type: 'revenue' as const, debit: 0, credit: 125000, balance: 125000 },
  ],
  totalDebit: 125000,
  totalCredit: 125000,
  balanced: true,
};

function renderBooks() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <BooksView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('BooksView', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchLedgerAccounts').mockResolvedValue(ACCOUNTS);
    vi.spyOn(registry, 'fetchJournalEntries').mockResolvedValue([entry()]);
    vi.spyOn(registry, 'fetchTrialBalance').mockResolvedValue(BALANCED);
    vi.spyOn(registry, 'fetchLedgerPeriods').mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens on the trial balance and shows money in major units', async () => {
    renderBooks();
    // 125000 minor units is 1,250.00 — never 125000. It shows up in both the
    // totals and the account rows, so match all of them.
    const amounts = await screen.findAllByText('1,250.00');
    expect(amounts.length).toBeGreaterThan(0);
    expect(screen.queryByText('125000')).toBeNull();
    expect(screen.getByTestId('books-balanced')).toBeTruthy();
    expect(screen.getByText('Accounts Receivable')).toBeTruthy();
  });

  it('raises an alarm when the books do not balance', async () => {
    vi.spyOn(registry, 'fetchTrialBalance').mockResolvedValue({
      ...BALANCED,
      totalCredit: 120000,
      balanced: false,
    });
    renderBooks();
    // Silence here would let a broken ledger look normal.
    expect(await screen.findByTestId('books-unbalanced-alarm')).toBeTruthy();
  });

  it('offers reversal, never an edit, for a posted entry', async () => {
    renderBooks();
    fireEvent.click(await screen.findByTestId('workspace-tab-journal'));
    fireEvent.click(await screen.findByText('Invoice INV-1001'));
    const drawer = await screen.findByTestId('books-entry-drawer');
    expect(drawer).toBeTruthy();
    expect(screen.getByTestId('books-reverse')).toBeTruthy();
    expect(screen.queryByText(/^Edit$/)).toBeNull();
    expect(screen.getByText(/never edited/i)).toBeTruthy();
  });

  it('does not offer to reverse an entry that was already reversed', async () => {
    vi.spyOn(registry, 'fetchJournalEntries').mockResolvedValue([
      entry({ reversedByEntryId: 'je-2' }),
    ]);
    renderBooks();
    fireEvent.click(await screen.findByTestId('workspace-tab-journal'));
    fireEvent.click(await screen.findByText('Invoice INV-1001'));
    await screen.findByTestId('books-entry-drawer');
    expect(screen.queryByTestId('books-reverse')).toBeNull();
  });

  it('closes a period through the API', async () => {
    const close = vi.spyOn(registry, 'closeLedgerPeriod').mockResolvedValue({
      id: 'per-1',
      orgId: 'ws-1',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      status: 'closed',
      closedAt: 5,
      closedBy: 'wsm-1',
      createdAt: 5,
    });
    renderBooks();
    fireEvent.click(await screen.findByTestId('workspace-tab-periods'));
    fireEvent.change(await screen.findByTestId('books-close-start'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.change(screen.getByTestId('books-close-end'), { target: { value: '2026-06-30' } });
    fireEvent.click(screen.getByTestId('books-close-submit'));
    await waitFor(() => {
      expect(close).toHaveBeenCalledWith('ws-1', '2026-06-01', '2026-06-30');
    });
  });
});
