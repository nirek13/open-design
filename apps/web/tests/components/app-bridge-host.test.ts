import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_BRIDGE_PROTOCOL } from '@open-design/contracts';

import { AppBridgeRefused, performAppBridgeRequest } from '../../src/components/apps/app-bridge-host';
import * as registry from '../../src/providers/registry';

describe('performAppBridgeRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a query the published app did not declare', async () => {
    await expect(
      performAppBridgeRequest(
        'ws-1',
        { protocol: APP_BRIDGE_PROTOCOL, id: 'r1', kind: 'query', table: 'tenders' },
        [{ table: 'invoices', mode: 'read' }],
      ),
    ).rejects.toBeInstanceOf(AppBridgeRefused);
  });

  it('queries through the member session in project preview', async () => {
    vi.spyOn(registry, 'queryWorkspaceRecords').mockResolvedValue({
      records: [
        {
          id: 'rec-1',
          tableId: 'tbl-1',
          data: { title: 'NPP' },
          revision: 1,
          createdByKind: 'user',
          createdById: 'u1',
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
      nextCursor: null,
    });
    const result = await performAppBridgeRequest(
      'ws-1',
      { protocol: APP_BRIDGE_PROTOCOL, id: 'r1', kind: 'query', table: 'tenders', limit: 50 },
      'preview',
    );
    expect(registry.queryWorkspaceRecords).toHaveBeenCalledWith('ws-1', 'tenders', { limit: 50 });
    expect(result).toEqual({
      records: [expect.objectContaining({ id: 'rec-1' })],
    });
  });
});
