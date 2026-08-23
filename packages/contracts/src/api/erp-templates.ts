// ERP templates: named packs of tables an organization can install.
//
// The business hub (api/business-hub.ts) proved the shape — seed ordinary
// workspace tables, mark the handful of fields automatic accounting reads with
// a role, and let people add columns freely afterwards. This file generalizes
// that from one hardcoded pack into a registry, so "give me a CRM" and "give
// me purchasing" are the same operation with a different argument.
//
// Why a registry rather than more hardcoded setup functions: the packs differ
// only in data. A template that is data can be listed in the UI, installed by
// id from the CLI, previewed before it writes anything, and extended by a
// future pack without touching the installer. A template that is code cannot.
//
// Installing is always additive and never destructive. A table that already
// exists is left exactly as the organization has customized it — see
// `TemplateInstallResult.skipped`. That rule is what makes it safe to install
// `purchasing` a year after `sales`, or to re-run an install to pick up a pack
// that has since gained a table.

import {
  HUB_SCHEMA,
  type HubFieldSpec,
  type HubTableSpec,
} from './business-hub.js';
import type { LedgerAccountType } from './ledger.js';

/** Packs available to install. `sales` is the original business hub, kept
 * under its own id so existing setup calls keep meaning what they meant. */
export const ERP_TEMPLATE_IDS = [
  'sales',
  'crm',
  'purchasing',
  'inventory',
  'projects',
  'expenses',
  'hr',
  'support',
] as const;

export type ErpTemplateId = (typeof ERP_TEMPLATE_IDS)[number];

/** A template's table spec. Identical to the hub's, except `name` and `linkTo`
 * are free strings: a pack may introduce tables the hub never knew about, and
 * link to them. */
export interface TemplateFieldSpec extends Omit<HubFieldSpec, 'linkTo'> {
  /** For link fields: the machine name of the table this points at. The target
   * may come from this pack or from one installed earlier. */
  linkTo?: string;
}

export interface TemplateTableSpec extends Omit<HubTableSpec, 'name' | 'fields'> {
  name: string;
  fields: TemplateFieldSpec[];
}

export interface ErpTemplate {
  id: ErpTemplateId;
  displayName: string;
  /** One line, shown in the install picker. */
  description: string;
  /** Tables to create, in an order that satisfies their own links. The
   * installer additionally topologically sorts by `linkTo`, so this order is
   * documentation rather than a load-bearing detail. */
  tables: TemplateTableSpec[];
  /** Accounts this pack needs beyond the default chart. Seeding is idempotent:
   * a code that already exists is left alone. */
  accounts?: ReadonlyArray<{ code: string; name: string; type: LedgerAccountType }>;
  /** Templates that must be installed first, because this pack links into
   * their tables. Installing a template installs its requirements too. */
  requires?: ErpTemplateId[];
}

// --- CRM ------------------------------------------------------------------

/** Where a deal sits. Won and lost are terminal; `won` is the stage that
 * offers to become a quote. */
export const DEAL_STAGES = [
  'new',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

/** Stages a deal can no longer move out of by ordinary pipeline work. */
export const CLOSED_DEAL_STAGES: readonly DealStage[] = ['won', 'lost'];

export const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note', 'task'] as const;

export const LEAD_SOURCES = [
  'referral',
  'website',
  'outbound',
  'event',
  'partner',
  'other',
] as const;

const CRM_TABLES: TemplateTableSpec[] = [
  {
    name: 'contacts',
    displayName: 'Contacts',
    description: 'The people you actually talk to, at the companies you sell to.',
    fields: [
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'email', displayName: 'Email', type: 'text' },
      { name: 'phone', displayName: 'Phone', type: 'text' },
      { name: 'job_title', displayName: 'Title', type: 'text' },
      {
        name: 'customer',
        displayName: 'Company',
        type: 'link',
        role: 'customer-link',
        linkTo: 'customers',
      },
      { name: 'is_primary', displayName: 'Primary contact', type: 'boolean' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'deals',
    displayName: 'Deals',
    description: 'Open opportunities and what stage each one is at.',
    fields: [
      { name: 'title', displayName: 'Deal', type: 'text', required: true },
      {
        name: 'customer',
        displayName: 'Company',
        type: 'link',
        required: true,
        role: 'customer-link',
        linkTo: 'customers',
      },
      { name: 'contact', displayName: 'Contact', type: 'link', role: 'contact-link', linkTo: 'contacts' },
      {
        name: 'stage',
        displayName: 'Stage',
        type: 'select',
        required: true,
        role: 'deal-stage',
        options: [...DEAL_STAGES],
      },
      { name: 'value', displayName: 'Value', type: 'money', role: 'deal-value' },
      // Kept as an integer percentage rather than a fraction: everyone writes
      // "60%" on a whiteboard, nobody writes 0.6.
      { name: 'probability', displayName: 'Probability %', type: 'integer', role: 'deal-probability' },
      { name: 'expected_close', displayName: 'Expected close', type: 'date', role: 'due-date' },
      { name: 'owner', displayName: 'Owner', type: 'text', role: 'owner' },
      { name: 'source', displayName: 'Source', type: 'select', role: 'lead-source', options: [...LEAD_SOURCES] },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'activities',
    displayName: 'Activities',
    description: 'Calls, emails, and meetings — what happened and what is next.',
    fields: [
      { name: 'subject', displayName: 'Subject', type: 'text', required: true },
      {
        name: 'activity_type',
        displayName: 'Type',
        type: 'select',
        required: true,
        role: 'activity-type',
        options: [...ACTIVITY_TYPES],
      },
      { name: 'occurred_at', displayName: 'When', type: 'datetime', role: 'issue-date' },
      { name: 'customer', displayName: 'Company', type: 'link', role: 'customer-link', linkTo: 'customers' },
      { name: 'contact', displayName: 'Contact', type: 'link', role: 'contact-link', linkTo: 'contacts' },
      { name: 'deal', displayName: 'Deal', type: 'link', role: 'deal-link', linkTo: 'deals' },
      { name: 'owner', displayName: 'Owner', type: 'text', role: 'owner' },
      { name: 'done', displayName: 'Done', type: 'boolean', role: 'completed' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- Purchasing -----------------------------------------------------------

export const PURCHASE_ORDER_STATUSES = ['draft', 'sent', 'received', 'cancelled'] as const;

/** A bill is the vendor's invoice to us. `approved` is the accounting event:
 * that is when we accept that we owe the money. */
export const BILL_STATUSES = ['draft', 'approved', 'paid', 'void'] as const;

const PURCHASING_TABLES: TemplateTableSpec[] = [
  {
    name: 'vendors',
    displayName: 'Vendors',
    description: 'People and companies you buy from.',
    fields: [
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'email', displayName: 'Email', type: 'text' },
      { name: 'phone', displayName: 'Phone', type: 'text' },
      { name: 'address', displayName: 'Address', type: 'text' },
      { name: 'payment_terms', displayName: 'Terms', type: 'text' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'purchase_orders',
    displayName: 'Purchase orders',
    description: 'What you have ordered from a vendor. Committing, not yet owing.',
    fields: [
      {
        name: 'po_number',
        displayName: 'PO #',
        type: 'text',
        required: true,
        unique: true,
        role: 'document-number',
      },
      {
        name: 'vendor',
        displayName: 'Vendor',
        type: 'link',
        required: true,
        role: 'vendor-link',
        linkTo: 'vendors',
      },
      { name: 'issue_date', displayName: 'Ordered', type: 'date', required: true, role: 'issue-date' },
      { name: 'expected_date', displayName: 'Expected', type: 'date', role: 'due-date' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...PURCHASE_ORDER_STATUSES],
      },
      { name: 'subtotal', displayName: 'Subtotal', type: 'money', role: 'subtotal' },
      { name: 'tax', displayName: 'Tax', type: 'money', role: 'tax' },
      { name: 'total', displayName: 'Total', type: 'money', required: true, role: 'total' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'bills',
    displayName: 'Bills',
    description: 'What a vendor has billed you. Approving one writes to the books.',
    fields: [
      {
        name: 'bill_number',
        displayName: 'Bill #',
        type: 'text',
        required: true,
        unique: true,
        role: 'document-number',
      },
      {
        name: 'vendor',
        displayName: 'Vendor',
        type: 'link',
        required: true,
        role: 'vendor-link',
        linkTo: 'vendors',
      },
      {
        name: 'purchase_order',
        displayName: 'PO',
        type: 'link',
        role: 'purchase-order-link',
        linkTo: 'purchase_orders',
      },
      { name: 'issue_date', displayName: 'Billed', type: 'date', required: true, role: 'issue-date' },
      { name: 'due_date', displayName: 'Due', type: 'date', role: 'due-date' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...BILL_STATUSES],
      },
      { name: 'subtotal', displayName: 'Subtotal', type: 'money', role: 'subtotal' },
      { name: 'tax', displayName: 'Tax', type: 'money', role: 'tax' },
      { name: 'total', displayName: 'Total', type: 'money', required: true, role: 'total' },
      // Which expense account this bill lands in. A code rather than a link,
      // because the chart of accounts is not a workspace table.
      { name: 'expense_account', displayName: 'Expense account', type: 'text', role: 'expense-account' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'bill_payments',
    displayName: 'Bill payments',
    description: 'Money paid out. Recording one writes to the books.',
    fields: [
      {
        name: 'reference',
        displayName: 'Reference',
        type: 'text',
        required: true,
        unique: true,
        role: 'document-number',
      },
      { name: 'vendor', displayName: 'Vendor', type: 'link', role: 'vendor-link', linkTo: 'vendors' },
      { name: 'bill', displayName: 'Bill', type: 'link', role: 'bill-link', linkTo: 'bills' },
      { name: 'paid_date', displayName: 'Paid', type: 'date', required: true, role: 'issue-date' },
      {
        name: 'method',
        displayName: 'Method',
        type: 'select',
        role: 'payment-method',
        options: ['bank transfer', 'card', 'cash', 'cheque', 'other'],
      },
      { name: 'amount', displayName: 'Amount', type: 'money', required: true, role: 'amount' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- Inventory ------------------------------------------------------------

export const STOCK_MOVEMENT_KINDS = [
  'receipt',
  'shipment',
  'adjustment',
  'transfer',
  'write-off',
] as const;

export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/** Movements that increase stock. Everything else decreases it, which is why
 * the direction lives here rather than as a sign the user has to remember. */
export const INBOUND_MOVEMENT_KINDS: readonly StockMovementKind[] = ['receipt'];

const INVENTORY_TABLES: TemplateTableSpec[] = [
  {
    name: 'products',
    displayName: 'Products',
    description: 'What you sell or stock, and what it costs you.',
    fields: [
      { name: 'sku', displayName: 'SKU', type: 'text', required: true, unique: true, role: 'sku' },
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'description', displayName: 'Description', type: 'text' },
      { name: 'unit_price', displayName: 'Price', type: 'money', role: 'unit-price' },
      // What it cost us, which is what the books use — not what we charge.
      { name: 'unit_cost', displayName: 'Unit cost', type: 'money', role: 'unit-cost' },
      { name: 'reorder_point', displayName: 'Reorder at', type: 'integer', role: 'reorder-point' },
      { name: 'active', displayName: 'Active', type: 'boolean' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'warehouses',
    displayName: 'Locations',
    description: 'Where stock physically sits.',
    fields: [
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'address', displayName: 'Address', type: 'text' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'stock_movements',
    displayName: 'Stock movements',
    description: 'Every change in stock. On hand is the sum of these, never a stored number.',
    fields: [
      { name: 'reference', displayName: 'Reference', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'product', displayName: 'Product', type: 'link', required: true, role: 'product-link', linkTo: 'products' },
      { name: 'warehouse', displayName: 'Location', type: 'link', role: 'warehouse-link', linkTo: 'warehouses' },
      {
        name: 'movement_kind',
        displayName: 'Kind',
        type: 'select',
        required: true,
        role: 'movement-kind',
        options: [...STOCK_MOVEMENT_KINDS],
      },
      // Always positive; the kind decides the direction. A signed quantity
      // invites "-5 write-off", which nobody can read consistently.
      { name: 'quantity', displayName: 'Quantity', type: 'integer', required: true, role: 'quantity' },
      { name: 'unit_cost', displayName: 'Unit cost', type: 'money', role: 'unit-cost' },
      { name: 'moved_at', displayName: 'When', type: 'date', required: true, role: 'issue-date' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- Projects -------------------------------------------------------------

export const PROJECT_STATUSES = ['planned', 'active', 'on-hold', 'done', 'cancelled'] as const;
export const TASK_STATUSES = ['todo', 'in-progress', 'blocked', 'done'] as const;

const PROJECT_TABLES: TemplateTableSpec[] = [
  {
    name: 'projects',
    displayName: 'Projects',
    description: 'Work you are delivering, and who it is for.',
    fields: [
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'customer', displayName: 'Customer', type: 'link', role: 'customer-link', linkTo: 'customers' },
      { name: 'code', displayName: 'Code', type: 'text', unique: true, role: 'document-number' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...PROJECT_STATUSES],
      },
      { name: 'start_date', displayName: 'Starts', type: 'date', role: 'issue-date' },
      { name: 'end_date', displayName: 'Ends', type: 'date', role: 'due-date' },
      { name: 'budget', displayName: 'Budget', type: 'money', role: 'total' },
      { name: 'owner', displayName: 'Owner', type: 'text', role: 'owner' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'project_tasks',
    displayName: 'Tasks',
    description: 'The work itself, broken down.',
    fields: [
      { name: 'title', displayName: 'Task', type: 'text', required: true },
      { name: 'project', displayName: 'Project', type: 'link', required: true, role: 'project-link', linkTo: 'projects' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...TASK_STATUSES],
      },
      { name: 'assignee', displayName: 'Assignee', type: 'text', role: 'owner' },
      { name: 'due_date', displayName: 'Due', type: 'date', role: 'due-date' },
      { name: 'estimate_hours', displayName: 'Estimate (h)', type: 'number', role: 'estimate' },
      { name: 'done', displayName: 'Done', type: 'boolean', role: 'completed' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'time_entries',
    displayName: 'Time',
    description: 'Hours worked. Billable ones can become invoice lines.',
    fields: [
      { name: 'reference', displayName: 'Reference', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'project', displayName: 'Project', type: 'link', required: true, role: 'project-link', linkTo: 'projects' },
      { name: 'task', displayName: 'Task', type: 'link', role: 'task-link', linkTo: 'project_tasks' },
      { name: 'person', displayName: 'Person', type: 'text', required: true, role: 'owner' },
      { name: 'worked_on', displayName: 'Date', type: 'date', required: true, role: 'issue-date' },
      { name: 'hours', displayName: 'Hours', type: 'number', required: true, role: 'hours' },
      { name: 'billable', displayName: 'Billable', type: 'boolean', role: 'billable' },
      { name: 'rate', displayName: 'Rate', type: 'money', role: 'unit-price' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- Expenses -------------------------------------------------------------

/** An expense claim is money someone spent on the company's behalf.
 * `approved` is the accounting event — that is when we accept we owe them. */
export const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'reimbursed', 'rejected'] as const;

export const EXPENSE_CATEGORIES = [
  'travel',
  'meals',
  'software',
  'equipment',
  'office',
  'training',
  'other',
] as const;

const EXPENSE_TABLES: TemplateTableSpec[] = [
  {
    name: 'expense_claims',
    displayName: 'Expenses',
    description: 'What people spent on the company. Approving one writes to the books.',
    fields: [
      { name: 'reference', displayName: 'Reference', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'person', displayName: 'Person', type: 'text', required: true, role: 'owner' },
      { name: 'spent_on', displayName: 'Date', type: 'date', required: true, role: 'issue-date' },
      {
        name: 'category',
        displayName: 'Category',
        type: 'select',
        required: true,
        role: 'expense-category',
        options: [...EXPENSE_CATEGORIES],
      },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...EXPENSE_STATUSES],
      },
      { name: 'description', displayName: 'What for', type: 'text' },
      // No project link here on purpose. Expenses must stand alone — a company
      // with no project tracking still has expense claims — and requiring the
      // projects pack to install this one would be the wrong trade. Anyone who
      // wants expenses tagged by project can add the field, which is the whole
      // premise of these tables being ordinary and extensible.
      { name: 'tax', displayName: 'Tax', type: 'money', role: 'tax' },
      { name: 'total', displayName: 'Total', type: 'money', required: true, role: 'total' },
      { name: 'expense_account', displayName: 'Expense account', type: 'text', role: 'expense-account' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- People ---------------------------------------------------------------

export const EMPLOYMENT_STATUSES = ['active', 'on-leave', 'left'] as const;
export const TIME_OFF_KINDS = ['holiday', 'sick', 'parental', 'unpaid', 'other'] as const;
export const TIME_OFF_STATUSES = ['requested', 'approved', 'declined', 'cancelled'] as const;

const HR_TABLES: TemplateTableSpec[] = [
  {
    name: 'employees',
    displayName: 'People',
    description: 'Who works here, and in what role.',
    fields: [
      { name: 'name', displayName: 'Name', type: 'text', required: true },
      { name: 'email', displayName: 'Email', type: 'text' },
      { name: 'job_title', displayName: 'Title', type: 'text' },
      { name: 'department', displayName: 'Department', type: 'text' },
      { name: 'manager', displayName: 'Manager', type: 'link', role: 'manager-link', linkTo: 'employees' },
      { name: 'started_on', displayName: 'Started', type: 'date', role: 'issue-date' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...EMPLOYMENT_STATUSES],
      },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
  {
    name: 'time_off',
    displayName: 'Time off',
    description: 'Who is away, when, and whether it was agreed.',
    fields: [
      { name: 'reference', displayName: 'Reference', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'employee', displayName: 'Person', type: 'link', required: true, role: 'employee-link', linkTo: 'employees' },
      {
        name: 'kind',
        displayName: 'Kind',
        type: 'select',
        required: true,
        role: 'time-off-kind',
        options: [...TIME_OFF_KINDS],
      },
      { name: 'start_date', displayName: 'From', type: 'date', required: true, role: 'issue-date' },
      { name: 'end_date', displayName: 'To', type: 'date', required: true, role: 'due-date' },
      { name: 'days', displayName: 'Days', type: 'number', role: 'quantity' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...TIME_OFF_STATUSES],
      },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- Support --------------------------------------------------------------

export const TICKET_STATUSES = ['new', 'open', 'waiting', 'resolved', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const SUPPORT_TABLES: TemplateTableSpec[] = [
  {
    name: 'tickets',
    displayName: 'Tickets',
    description: 'What customers have asked for, and who is on it.',
    fields: [
      { name: 'reference', displayName: 'Ticket #', type: 'text', required: true, unique: true, role: 'document-number' },
      { name: 'subject', displayName: 'Subject', type: 'text', required: true },
      { name: 'customer', displayName: 'Customer', type: 'link', role: 'customer-link', linkTo: 'customers' },
      { name: 'contact', displayName: 'Contact', type: 'link', role: 'contact-link', linkTo: 'contacts' },
      {
        name: 'status',
        displayName: 'Status',
        type: 'select',
        required: true,
        role: 'status',
        options: [...TICKET_STATUSES],
      },
      {
        name: 'priority',
        displayName: 'Priority',
        type: 'select',
        required: true,
        role: 'priority',
        options: [...TICKET_PRIORITIES],
      },
      { name: 'assignee', displayName: 'Assignee', type: 'text', role: 'owner' },
      { name: 'opened_at', displayName: 'Opened', type: 'date', required: true, role: 'issue-date' },
      { name: 'due_date', displayName: 'Due', type: 'date', role: 'due-date' },
      { name: 'resolved', displayName: 'Resolved', type: 'boolean', role: 'completed' },
      { name: 'notes', displayName: 'Notes', type: 'text', role: 'notes' },
    ],
  },
];

// --- The registry ---------------------------------------------------------

export const ERP_TEMPLATES: readonly ErpTemplate[] = [
  {
    id: 'sales',
    displayName: 'Sales',
    description: 'Customers, quotes, orders, invoices, and payments received.',
    // The hub schema is the sales pack. One definition, so the two can never
    // drift into disagreeing about what `invoices` looks like.
    tables: HUB_SCHEMA as unknown as TemplateTableSpec[],
  },
  {
    id: 'crm',
    displayName: 'CRM',
    description: 'Contacts, a deal pipeline, and the activity log behind both.',
    tables: CRM_TABLES,
    // Deals and contacts link to customers, which the sales pack owns.
    requires: ['sales'],
  },
  {
    id: 'purchasing',
    displayName: 'Purchasing',
    description: 'Vendors, purchase orders, bills, and payments made.',
    tables: PURCHASING_TABLES,
    accounts: [
      { code: '1200', name: 'Prepaid Expenses', type: 'asset' },
      { code: '1300', name: 'Inventory', type: 'asset' },
      { code: '2110', name: 'Tax Receivable', type: 'asset' },
    ],
  },
  {
    id: 'inventory',
    displayName: 'Inventory',
    description: 'Products, locations, and stock that is counted rather than stored.',
    tables: INVENTORY_TABLES,
    accounts: [{ code: '1300', name: 'Inventory', type: 'asset' }],
  },
  {
    id: 'projects',
    displayName: 'Projects',
    description: 'Projects, tasks, and the hours booked against them.',
    tables: PROJECT_TABLES,
    // Projects link to customers.
    requires: ['sales'],
  },
  {
    id: 'expenses',
    displayName: 'Expenses',
    description: 'Expense claims that post to the books when approved.',
    tables: EXPENSE_TABLES,
    accounts: [
      { code: '2200', name: 'Employee Reimbursements', type: 'liability' },
      // Also seeded by purchasing. Seeding is idempotent by code, so a pack
      // declaring every account its postings need is correct even when another
      // pack declares the same one — and it keeps each pack installable alone.
      { code: '2110', name: 'Tax Receivable', type: 'asset' },
    ],
  },
  {
    id: 'hr',
    displayName: 'People',
    description: 'Employees, reporting lines, and time off.',
    tables: HR_TABLES,
  },
  {
    id: 'support',
    displayName: 'Support',
    description: 'Customer tickets, prioritised and assigned.',
    tables: SUPPORT_TABLES,
    // Tickets link to customers and contacts, which sales and CRM own.
    requires: ['crm'],
  },
];

export function findErpTemplate(id: string): ErpTemplate | null {
  return ERP_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function isErpTemplateId(value: string): value is ErpTemplateId {
  return ERP_TEMPLATE_IDS.includes(value as ErpTemplateId);
}

/** Expand a template id into itself plus everything it requires, dependencies
 * first and each id appearing once. Callers install the returned list in
 * order. */
export function resolveTemplateOrder(id: ErpTemplateId): ErpTemplateId[] {
  const seen = new Set<ErpTemplateId>();
  const out: ErpTemplateId[] = [];
  const visit = (current: ErpTemplateId) => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const required of findErpTemplate(current)?.requires ?? []) visit(required);
    out.push(current);
  };
  visit(id);
  return out;
}

// --- Install results ------------------------------------------------------

export interface TemplateInstallResult {
  templateId: ErpTemplateId;
  /** Tables this call created. */
  created: string[];
  /** Tables left untouched because they already existed. Setup never
   * overwrites a table an organization has customized. */
  skipped: string[];
  accountsCreated: number;
}

export interface TemplateStatus {
  templateId: ErpTemplateId;
  displayName: string;
  description: string;
  /** True when every table in the pack exists. */
  installed: boolean;
  tables: Array<{ name: string; displayName: string; present: boolean; tableId: string | null; recordCount: number }>;
  requires: ErpTemplateId[];
}

export interface ListTemplatesResponse {
  templates: TemplateStatus[];
}

export interface InstallTemplateRequest {
  templateId: ErpTemplateId;
}

export interface InstallTemplateResponse {
  /** One entry per template actually installed, dependencies included. */
  installed: TemplateInstallResult[];
}

// --- Pipeline -------------------------------------------------------------

/** One column of the deal board. Totals are minor units, like every other
 * amount in the system. */
export interface DealPipelineStage {
  stage: DealStage;
  dealCount: number;
  totalValue: number;
  /** Value weighted by each deal's probability, rounded to whole minor units.
   * The number people forecast with. */
  weightedValue: number;
  deals: Array<{
    recordId: string;
    title: string;
    customerName: string | null;
    value: number;
    probability: number | null;
    expectedClose: string | null;
    owner: string | null;
  }>;
}

export interface PipelineSummary {
  currency: string;
  stages: DealPipelineStage[];
  openValue: number;
  weightedValue: number;
  wonValue: number;
  lostValue: number;
}

export interface PipelineResponse {
  pipeline: PipelineSummary;
}

export interface MoveDealStageRequest {
  stage: DealStage;
}

/** What a won deal becomes. Returns the prepared quote row rather than writing
 * it, matching how quote → order → invoice conversion already behaves. */
export interface DealToQuoteResponse {
  table: string;
  data: Record<string, unknown>;
}

// --- Purchasing views -----------------------------------------------------

/** What is owed to vendors, oldest first. The buy-side mirror of the
 * receivables view. */
export interface PayablesRow {
  recordId: string;
  billNumber: string;
  vendorName: string | null;
  issueDate: string;
  dueDate: string | null;
  total: number;
  paid: number;
  outstanding: number;
  status: string;
  /** Days past due; negative when not yet due. */
  daysOverdue: number;
}

export interface PayablesSummary {
  currency: string;
  rows: PayablesRow[];
  totalOutstanding: number;
  totalOverdue: number;
}

export interface PayablesResponse {
  payables: PayablesSummary;
}

/** What customers owe us — the sell-side mirror of payables. */
export type ReceivablesRow = PayablesRow;
export type ReceivablesSummary = PayablesSummary;

export interface ReceivablesResponse {
  receivables: ReceivablesSummary;
}

// --- Inventory views ------------------------------------------------------

/** On hand for one product, summed from its movements. There is no stored
 * quantity anywhere — a stored one drifts the first time stock changes through
 * a path that forgets to update it. */
export interface StockLevel {
  productId: string;
  sku: string;
  name: string;
  onHand: number;
  /** Null when the product has no reorder point set. */
  reorderPoint: number | null;
  /** True when on hand has fallen to or below the reorder point. */
  belowReorderPoint: boolean;
  unitCost: number;
  /** On hand valued at unit cost, in minor units. */
  stockValue: number;
}

export interface StockSummary {
  currency: string;
  levels: StockLevel[];
  totalValue: number;
  /** Products at or below their reorder point — what to buy next. */
  needsReorder: number;
}

export interface StockResponse {
  stock: StockSummary;
}

// --- Project views --------------------------------------------------------

/** Hours and money on one project. Billable value is hours × rate, summed per
 * entry rather than from an average, because rates differ per person. */
export interface ErpProjectSummaryRow {
  projectId: string;
  name: string;
  code: string | null;
  status: string;
  customerName: string | null;
  budget: number;
  hours: number;
  billableHours: number;
  /** Billable hours priced at each entry's own rate. */
  billableValue: number;
  taskCount: number;
  openTaskCount: number;
  /** Budget minus billable value; negative means over budget. */
  budgetRemaining: number;
}

export interface ErpProjectsSummary {
  currency: string;
  projects: ErpProjectSummaryRow[];
  totalHours: number;
  totalBillableValue: number;
}

export interface ErpProjectsResponse {
  projects: ErpProjectsSummary;
}
