// Double-entry accounting.
//
// This is the one part of the system that is deliberately rigid. Business
// documents live in user-editable tables so anyone can add a field by asking;
// the ledger does not, because the value of a ledger is precisely that it
// cannot be talked into an inconsistent state.
//
// Three rules the platform enforces rather than trusts:
//
//   1. Every entry balances. Debits equal credits, per currency, checked at
//      the posting chokepoint — a draft that does not balance cannot post.
//   2. Posted entries are immutable. A mistake is corrected by posting a
//      reversing entry, never by editing history. Both entries link to each
//      other so the correction is legible.
//   3. Money is integer minor units. No floats touch an amount, anywhere.
//
// Every entry carries a source reference back to the document that caused it,
// so any number in the books can be traced to the invoice or payment behind it.

/** The five classical account types. Normal balance follows from the type:
 * assets and expenses are debit-normal; liabilities, equity, and revenue are
 * credit-normal. */
export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const LEDGER_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

export function isDebitNormal(type: LedgerAccountType): boolean {
  return type === 'asset' || type === 'expense';
}

export interface LedgerAccount {
  id: string;
  orgId: string;
  /** Stable human code, e.g. "1100". Unique within the organization. */
  code: string;
  name: string;
  type: LedgerAccountType;
  /** ISO 4217. All entries touching this account use this currency. */
  currency: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';

export type LedgerLineDirection = 'debit' | 'credit';

export interface JournalLine {
  id: string;
  entryId: string;
  accountId: string;
  accountCode?: string;
  accountName?: string;
  direction: LedgerLineDirection;
  /** Always positive integer minor units. Direction carries the sign. */
  amount: number;
  memo: string | null;
  position: number;
}

/** What caused this entry to exist. A journal entry with no source is a
 * manual adjustment; everything the system posts on its own names the
 * document it came from. */
export interface JournalSource {
  kind:
    | 'manual'
    | 'invoice'
    | 'payment'
    | 'quote'
    | 'import'
    // Buy side (api/erp-templates.ts): a vendor's bill and what we paid
    // against it.
    | 'bill'
    | 'bill-payment'
    // Someone spent their own money on the company's behalf.
    | 'expense-claim'
    // Stock leaving without a sale — breakage, loss, obsolescence.
    | 'stock-write-off';
  /** Table and record in the business hub, when the source is a document. */
  tableId?: string;
  recordId?: string;
  /** Human label for the books, e.g. "Invoice INV-1042". */
  label?: string;
}

export interface JournalEntry {
  id: string;
  orgId: string;
  /** Sequential within the organization once posted; null while draft. */
  number: number | null;
  /** Accounting date (YYYY-MM-DD), which is not necessarily when it was entered. */
  date: string;
  memo: string | null;
  currency: string;
  status: JournalEntryStatus;
  source: JournalSource;
  /** Set on the original when it has been reversed. */
  reversedByEntryId: string | null;
  /** Set on a reversing entry, pointing at what it corrects. */
  reversesEntryId: string | null;
  postedAt: number | null;
  postedBy: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lines: JournalLine[];
}

export interface JournalLineInput {
  accountId?: string;
  /** Accepted instead of accountId so callers can write readable entries. */
  accountCode?: string;
  direction: LedgerLineDirection;
  amount: number;
  memo?: string;
}

export interface CreateJournalEntryRequest {
  date: string;
  memo?: string;
  currency?: string;
  source?: JournalSource;
  lines: JournalLineInput[];
}

export interface CreateLedgerAccountRequest {
  code: string;
  name: string;
  type: LedgerAccountType;
  currency?: string;
}

/** An accounting period. Closing one freezes it: nothing may post into a
 * closed period, which is what makes a reported figure final. */
export type LedgerPeriodStatus = 'open' | 'closed';

export interface LedgerPeriod {
  id: string;
  orgId: string;
  /** Inclusive bounds, YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  status: LedgerPeriodStatus;
  closedAt: number | null;
  closedBy: string | null;
  createdAt: number;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  debit: number;
  credit: number;
  /** Signed balance in the account's normal direction. */
  balance: number;
}

export interface TrialBalance {
  currency: string;
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** True when debits equal credits across the whole ledger. If this is ever
   * false the books are broken and the UI should say so loudly. */
  balanced: boolean;
}

export interface LedgerAccountsResponse {
  accounts: LedgerAccount[];
}

export interface JournalEntryResponse {
  entry: JournalEntry;
}

export interface JournalEntriesResponse {
  entries: JournalEntry[];
}

export interface LedgerPeriodsResponse {
  periods: LedgerPeriod[];
}

export interface TrialBalanceResponse {
  trialBalance: TrialBalance;
}

/** The chart of accounts a new organization starts with. Deliberately small —
 * enough to quote, invoice, and get paid — because an unfamiliar 200-account
 * chart is worse than none. More accounts get added by asking. */
export const DEFAULT_CHART_OF_ACCOUNTS: ReadonlyArray<{
  code: string;
  name: string;
  type: LedgerAccountType;
}> = [
  { code: '1000', name: 'Cash', type: 'asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { code: '2000', name: 'Accounts Payable', type: 'liability' },
  { code: '2100', name: 'Tax Payable', type: 'liability' },
  { code: '3000', name: 'Owner Equity', type: 'equity' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense' },
  { code: '6000', name: 'Operating Expenses', type: 'expense' },
];
