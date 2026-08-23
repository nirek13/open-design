// Packs an organization wrote itself.
//
// Same shape as a built-in `ErpTemplate`, but stored per organization instead
// of shipped as code. That is the whole point: a customer who needs "Fleet" or
// "Clinics" should not have to wait for us to write it, and the assistant
// should be able to draft one on their behalf.
//
// Because a custom pack becomes real tables, everything about it is validated
// before it is stored — see `workspace-data/packs.ts`. A spec that would not
// install is rejected at authoring time, not at install time, which is after
// someone pressed a button expecting it to work.

import type { LedgerAccountType } from './ledger.js';
import type { TemplateTableSpec } from './erp-templates.js';

/** The definition itself, independent of who stored it. This is what gets
 * exported, shared between organizations, and drafted by the assistant. */
export interface CustomTemplatePackSpec {
  displayName: string;
  description: string;
  tables: TemplateTableSpec[];
  /** Ledger accounts this pack's postings need. Seeding is idempotent, so
   * declaring one another pack also declares is correct and harmless. */
  accounts?: ReadonlyArray<{ code: string; name: string; type: LedgerAccountType }>;
}

export interface CustomTemplatePack {
  id: string;
  orgId: string;
  /** Machine name, unique per organization — how the installer addresses it. */
  slug: string;
  displayName: string;
  description: string;
  spec: CustomTemplatePackSpec;
  /** `agent` means the assistant drafted it. Kept so a reviewer can tell the
   * difference between a pack a person wrote and one a model proposed. */
  origin: 'user' | 'agent';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCustomPackRequest {
  spec: CustomTemplatePackSpec;
  slug?: string;
}

export interface CustomPackListResponse {
  packs: CustomTemplatePack[];
}

export interface CustomPackResponse {
  pack: CustomTemplatePack;
}
