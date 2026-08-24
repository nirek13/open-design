// @vitest-environment jsdom

// Approvals. The promise is that nothing changes company data without a
// person seeing what would change and saying yes — so the preview must be on
// screen next to the button, and an applied change must stay undoable.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalsView } from '../src/components/approvals/ApprovalsView';
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

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-1',
    orgId: 'ws-1',
    intent: 'Add PO numbers to orders',
    origin: 'agent' as const,
    runId: null,
    status: 'pending' as const,
    operations: [],
    preview: {
      lines: [{ summary: 'Add "po_number" to Orders', detail: 'type: text' }],
      warnings: [],
    },
    appliedEffects: [],
    error: null,
    createdBy: 'wsm-1',
    decidedBy: null,
    decidedAt: null,
    appliedAt: null,
    undoneAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function renderApprovals() {
  return render(
    <I18nProvider initial="en">
      <OrgProvider>
        <ApprovalsView active />
      </OrgProvider>
    </I18nProvider>,
  );
}

describe('ApprovalsView', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'fetchAuthContext').mockResolvedValue({
      mode: 'local-owner',
      viewer: { userId: 'user-local-owner', displayName: 'Local Owner', email: null, username: null },
      organizations: [ORG],
    });
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([proposal()]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows what would change beside the approve button', async () => {
    renderApprovals();
    expect(await screen.findByText('Add PO numbers to orders')).toBeTruthy();
    // Approving must never be a leap of faith.
    expect(screen.getByText('Add "po_number" to Orders')).toBeTruthy();
    expect(screen.getByText('type: text')).toBeTruthy();
    expect(screen.getByTestId('approval-approve')).toBeTruthy();
  });

  it('says who asked for the change', async () => {
    renderApprovals();
    expect(await screen.findByText(/From the assistant/)).toBeTruthy();
  });

  it('approves through the API', async () => {
    const decide = vi.spyOn(registry, 'decideProposal').mockResolvedValue(proposal());
    renderApprovals();
    fireEvent.click(await screen.findByTestId('approval-approve'));
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('ws-1', 'prop-1', 'approve');
    });
  });

  it('offers undo on an applied change, and is honest about what undo keeps', async () => {
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([proposal({ status: 'applied' })]);
    renderApprovals();
    fireEvent.click(await screen.findByTestId('workspace-tab-applied'));
    expect(await screen.findByTestId('approval-undo')).toBeTruthy();
    // Undo restores data but keeps a new field, and the UI must say so
    // rather than implying everything went back.
    expect(screen.getByText(/A new field or table stays/)).toBeTruthy();
  });

  it('surfaces preview warnings rather than hiding them', async () => {
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([
      proposal({
        preview: { lines: [], warnings: ['Operation 1: table not found'] },
      }),
    ]);
    renderApprovals();
    expect(await screen.findByText('Operation 1: table not found')).toBeTruthy();
  });

  it('says plainly when nothing is waiting', async () => {
    vi.spyOn(registry, 'fetchProposals').mockResolvedValue([]);
    renderApprovals();
    expect(await screen.findByText('Nothing is waiting on you')).toBeTruthy();
  });
});
