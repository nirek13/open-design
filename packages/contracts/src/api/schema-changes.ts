// Changing a schema that already holds data.
//
// `add-field` is safe: it cannot damage anything that already exists. Rename,
// retype, and remove are not, so each one is preceded by an impact report and
// the caller has to accept any loss it describes.

import type { WorkspaceFieldType } from './workspace-data.js';

/** What a proposed change would cost, computed without making it. */
export interface FieldChangeImpact {
  tableName: string;
  fieldName: string;
  currentType: WorkspaceFieldType;
  recordCount: number;
  /** Rows that actually hold a value — the ones a change can hurt. */
  populatedCount: number;
  /** Values that cannot survive a type change. */
  valuesAtRisk: number;
  /** A few of them, so a person can see what kind of thing breaks. */
  sampleLosses: Array<{ recordId: string; value: string }>;
  /** Formula fields whose expression reads this field by name. */
  referencedByFormulas: string[];
  /** Saved views filtering, sorting, or grouping on it. */
  referencedByViews: string[];
  /** True when converting would make previously distinct values equal under a
   * unique constraint. */
  breaksUniqueness: boolean;
  /** Whether the change can be walked back. A rename and a removal can; a
   * retype that dropped values cannot bring them back. */
  reversible: boolean;
}

export interface RenameFieldRequest {
  to: string;
}

export interface RetypeFieldRequest {
  to: WorkspaceFieldType;
  /** Required when the impact report showed values that cannot convert. */
  acceptDataLoss?: boolean;
}

export interface UpdateFieldConfigRequest {
  displayName?: string;
  required?: boolean;
  options?: string[];
  formula?: string | null;
}

export interface ReorderFieldsRequest {
  /** Field names in the order wanted. Names left out keep their relative
   * place after the ones listed. */
  order: string[];
}

export interface FieldChangeImpactResponse {
  impact: FieldChangeImpact;
}
