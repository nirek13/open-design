// The business hub: customers, quotes, orders, invoices, payments.
//
// These are seeded as ordinary workspace tables, not hardcoded entities, and
// that is the whole point. "Add a PO number to orders" has to be answerable
// in seconds by anyone, which is only possible if orders are rows in a table
// whose schema can grow — not a fixed column list in a migration.
//
// What the platform does hardcode is the small set of *roles* a field can
// play, so automatic accounting knows which column is the total and which is
// the customer. A table can gain any number of fields; it just has to keep
// the ones the ledger relies on.

/** Well-known tables the hub understands. Everything else is a user table. */
export const HUB_TABLES = ['customers', 'quotes', 'orders', 'invoices', 'payments'] as const;

export type HubTableName = (typeof HUB_TABLES)[number];

/** The part a field plays in automatic accounting and cross-document links.
 * Fields without a role are free-form and safe to add, rename, or remove. */
export type HubFieldRole =
  | 'customer-link'
  | 'document-number'
  | 'issue-date'
  | 'due-date'
  | 'status'
  | 'subtotal'
  | 'tax'
  | 'total'
  | 'amount'
  | 'invoice-link'
  | 'payment-method'
  | 'notes'
  // CRM (api/erp-templates.ts). Roles are shared across packs on purpose: a
  // `customer-link` means the same thing on a deal as on an invoice, which is
  // what lets one search index and one record editor serve both.
  | 'contact-link'
  | 'deal-link'
  | 'deal-stage'
  | 'deal-value'
  | 'deal-probability'
  | 'lead-source'
  | 'activity-type'
  | 'owner'
  | 'completed'
  // Purchasing — the buy-side mirror of customer/invoice/payment.
  | 'vendor-link'
  | 'purchase-order-link'
  | 'bill-link'
  | 'expense-account'
  // Inventory. On-hand is summed from movements, so `quantity` and
  // `movement-kind` together are what the stock report reads.
  | 'sku'
  | 'unit-price'
  | 'unit-cost'
  | 'quantity'
  | 'reorder-point'
  | 'movement-kind'
  | 'product-link'
  | 'warehouse-link'
  // Projects and time.
  | 'project-link'
  | 'task-link'
  | 'hours'
  | 'estimate'
  | 'billable'
  // Expenses, people, and support.
  | 'expense-category'
  | 'employee-link'
  | 'manager-link'
  | 'time-off-kind'
  | 'priority';

export interface HubFieldSpec {
  name: string;
  displayName: string;
  type:
    | 'text'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'select'
    | 'money'
    | 'link'
    | 'json';
  required?: boolean;
  unique?: boolean;
  role?: HubFieldRole;
  options?: string[];
  /** For link fields: which hub table this points at. */
  linkTo?: HubTableName;
}

export interface HubTableSpec {
  name: HubTableName;
  displayName: string;
  description: string;
  fields: HubFieldSpec[];
}

/** Document lifecycle. Only `posted`/`paid` transitions touch the ledger —
 * a draft invoice is a piece of paper, not an accounting event. */
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
export const ORDER_STATUSES = ['draft', 'confirmed', 'fulfilled', 'cancelled'] as const;
export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'] as const;

/** The starting shape of the business hub. Every field here can be added to;
 * the ones carrying a `role` are the ones automatic accounting reads. */
export const HUB_SCHEMA: readonly HubTableSpec[] = [
  {
    name: 'customers',
    displayName: 'Customers',
    description: 'People and companies you sell to.',
    fields: [
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'email', displayName: 'Email', type: 'text' },
      { name: 'phone', displayName: 'Phone', type: 'text' },
      { name: 'billing_address', displayName: 'Billing address', type: 'text' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'quotes',
    displayName: 'Quotes',
    description: 'What you offered, before anyone committed.',
    fields: [
      { name: 'quote_number', displayName: 'Quote #', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'customer', displayName: 'Customer', type: 'link', required: true, role: 'customer-link', linkTo: 'customers' },
      { name: 'issue_date', displayName: 'Issued', type: 'date', required: true, role: 'issue-date' },
      { name: 'status', displayName: 'Status', type: 'select', required: true, role: 'status', options: [...QUOTE_STATUSES] },
      { name: 'subtotal', displayName: 'Subtotal', type: 'money', role: 'subtotal' },
      { name: 'tax', displayName: 'Tax', type: 'money', role: 'tax' },
      { name: 'total', displayName: 'Total', type: 'money', required: true, role: 'total' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'orders',
    displayName: 'Orders',
    description: 'Work you have committed to doing.',
    fields: [
      { name: 'order_number', displayName: 'Order #', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'customer', displayName: 'Customer', type: 'link', required: true, role: 'customer-link', linkTo: 'customers' },
      { name: 'issue_date', displayName: 'Ordered', type: 'date', required: true, role: 'issue-date' },
      { name: 'status', displayName: 'Status', type: 'select', required: true, role: 'status', options: [...ORDER_STATUSES] },
      { name: 'total', displayName: 'Total', type: 'money', required: true, role: 'total' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'invoices',
    displayName: 'Invoices',
    description: 'What you have billed. Posting one writes to the books.',
    fields: [
      { name: 'invoice_number', displayName: 'Invoice #', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'customer', displayName: 'Customer', type: 'link', required: true, role: 'customer-link', linkTo: 'customers' },
      { name: 'issue_date', displayName: 'Issued', type: 'date', required: true, role: 'issue-date' },
      { name: 'due_date', displayName: 'Due', type: 'date', role: 'due-date' },
      { name: 'status', displayName: 'Status', type: 'select', required: true, role: 'status', options: [...INVOICE_STATUSES] },
      { name: 'subtotal', displayName: 'Subtotal', type: 'money', role: 'subtotal' },
      { name: 'tax', displayName: 'Tax', type: 'money', role: 'tax' },
      { name: 'total', displayName: 'Total', type: 'money', required: true, role: 'total' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'payments',
    displayName: 'Payments',
    description: 'Money received. Recording one writes to the books.',
    fields: [
      { name: 'reference', displayName: 'Reference', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'customer', displayName: 'Customer', type: 'link', role: 'customer-link', linkTo: 'customers' },
      { name: 'invoice', displayName: 'Invoice', type: 'link', role: 'invoice-link', linkTo: 'invoices' },
      { name: 'received_date', displayName: 'Received', type: 'date', required: true, role: 'issue-date' },
      { name: 'method', displayName: 'Method', type: 'select', role: 'payment-method', options: ['bank transfer', 'card', 'cash', 'cheque', 'other'] },
      { name: 'amount', displayName: 'Amount', type: 'money', required: true, role: 'amount' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

export interface HubSetupResult {
  /** Tables created by this call. */
  created: HubTableName[];
  /** Tables that already existed and were left exactly as they are — setup
   * never overwrites a table someone has since customized. */
  skipped: HubTableName[];
  accountsCreated: number;
}

export interface HubStatus {
  ready: boolean;
  tables: Array<{ name: HubTableName; present: boolean; tableId: string | null; recordCount: number }>;
  accountCount: number;
}

export interface HubSetupResponse {
  setup: HubSetupResult;
}

export interface HubStatusResponse {
  status: HubStatus;
}
