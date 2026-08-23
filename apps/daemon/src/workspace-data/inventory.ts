// Stock on hand.
//
// On hand is summed from movements every time it is asked for. There is no
// stored quantity anywhere, and that is the whole design: a stored count is a
// second source of truth that goes wrong the first time stock changes through
// a path that forgets to update it — an import, a correction, a bug — and once
// it is wrong nothing in the system can tell.
//
// The cost of recomputing is one table scan. The cost of a wrong number is a
// stock take.

import {
  INBOUND_MOVEMENT_KINDS,
  type StockLevel,
  type StockSummary,
  type WorkspaceField,
  type WorkspaceRecord,
} from '@open-design/contracts';
import { fieldWithRole } from './hub.js';
import { loadTableByName } from './schema.js';
import { queryRecords } from './query.js';
import type Database from 'better-sqlite3';

type RecordsDb = Database.Database;

function text(record: WorkspaceRecord, field: WorkspaceField | null): string {
  if (!field) return '';
  const value = record.data[field.name];
  return typeof value === 'string' ? value : '';
}

function int(record: WorkspaceRecord, field: WorkspaceField | null): number {
  if (!field) return 0;
  const value = record.data[field.name];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableInt(record: WorkspaceRecord, field: WorkspaceField | null): number | null {
  if (!field) return null;
  const value = record.data[field.name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function loadStock(
  recordsDb: RecordsDb,
  options: { currency?: string; warehouseId?: string } = {},
): StockSummary {
  const currency = options.currency ?? 'USD';
  const products = loadTableByName(recordsDb, 'products');

  const skuField = fieldWithRole(products, 'sku');
  const costField = fieldWithRole(products, 'unit-cost');
  const reorderField = fieldWithRole(products, 'reorder-point');
  const nameField = products.fields.find((field) => field.type === 'text' && field.name !== skuField?.name);

  // Sum movements per product in one pass.
  const onHand = new Map<string, number>();
  try {
    const movements = loadTableByName(recordsDb, 'stock_movements');
    const productField = fieldWithRole(movements, 'product-link');
    const quantityField = fieldWithRole(movements, 'quantity');
    const kindField = fieldWithRole(movements, 'movement-kind');
    const warehouseField = fieldWithRole(movements, 'warehouse-link');

    if (productField && quantityField) {
      for (const record of queryRecords(recordsDb, movements, { limit: 5000 }).records) {
        if (options.warehouseId && text(record, warehouseField) !== options.warehouseId) continue;
        const productId = text(record, productField);
        if (!productId) continue;
        // Quantity is always recorded positive; the kind carries the sign, so
        // a user never has to remember to type a minus.
        const kind = kindField ? text(record, kindField) : 'receipt';
        const magnitude = Math.abs(int(record, quantityField));
        const delta = INBOUND_MOVEMENT_KINDS.includes(kind as never) ? magnitude : -magnitude;
        onHand.set(productId, (onHand.get(productId) ?? 0) + delta);
      }
    }
  } catch {
    // No movements table yet means nothing has moved; every product reads zero.
  }

  const levels: StockLevel[] = [];
  let totalValue = 0;
  let needsReorder = 0;

  for (const record of queryRecords(recordsDb, products, { limit: 2000 }).records) {
    const quantity = onHand.get(record.id) ?? 0;
    const unitCost = int(record, costField);
    const reorderPoint = nullableInt(record, reorderField);
    const stockValue = quantity * unitCost;
    const belowReorderPoint = reorderPoint !== null && quantity <= reorderPoint;

    totalValue += stockValue;
    if (belowReorderPoint) needsReorder += 1;

    levels.push({
      productId: record.id,
      sku: text(record, skuField),
      name: text(record, nameField ?? null),
      onHand: quantity,
      reorderPoint,
      belowReorderPoint,
      unitCost,
      stockValue,
    });
  }

  // What needs attention first: short stock, then the biggest holdings.
  levels.sort(
    (a, b) =>
      Number(b.belowReorderPoint) - Number(a.belowReorderPoint) || b.stockValue - a.stockValue,
  );

  return { currency, levels, totalValue, needsReorder };
}
