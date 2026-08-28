import { describe, expect, it } from 'vitest';

import { previewRowsFromCsv } from '../../src/components/workspace-home/importPreview';

describe('previewRowsFromCsv', () => {
  it('reads headers and a capped set of body rows', () => {
    const csv = 'name,role\nAda,eng\nGrace,design\nLin,ops\n';
    const preview = previewRowsFromCsv(csv, 2);
    expect(preview.headers).toEqual(['name', 'role']);
    expect(preview.rows).toEqual([
      ['Ada', 'eng'],
      ['Grace', 'design'],
    ]);
    expect(preview.totalRows).toBe(3);
  });

  it('keeps quoted commas inside a cell', () => {
    const preview = previewRowsFromCsv('city,note\n"New York, NY",hq\n');
    expect(preview.rows[0]).toEqual(['New York, NY', 'hq']);
  });
});
