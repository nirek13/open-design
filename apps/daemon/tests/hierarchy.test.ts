import { describe, expect, it } from 'vitest';
import {
  ownerInHierarchyScope,
  reportsToWouldCycle,
  visibleMemberIds,
} from '../src/workspace-data/hierarchy.js';

const members = [
  { id: 'owner', reportsTo: null },
  { id: 'manager', reportsTo: 'owner' },
  { id: 'report', reportsTo: 'manager' },
  { id: 'peer', reportsTo: 'owner' },
  { id: 'gone', reportsTo: 'owner', status: 'removed' },
];

describe('reporting hierarchy', () => {
  it('lets a person see themselves, everyone above, and everyone below', () => {
    expect([...visibleMemberIds(members, 'report')].sort()).toEqual(['manager', 'owner', 'report']);
    expect([...visibleMemberIds(members, 'manager')].sort()).toEqual(['manager', 'owner', 'report']);
    expect([...visibleMemberIds(members, 'peer')].sort()).toEqual(['owner', 'peer']);
    expect([...visibleMemberIds(members, 'owner')].sort()).toEqual(['manager', 'owner', 'peer', 'report']);
  });

  it('hides removed members and unknown viewers', () => {
    expect(visibleMemberIds(members, 'gone').size).toBe(0);
    expect(visibleMemberIds(members, 'nobody').size).toBe(0);
  });

  it('refuses a reporting cycle', () => {
    expect(reportsToWouldCycle(members, 'owner', 'report')).toBe(true);
    expect(reportsToWouldCycle(members, 'peer', 'manager')).toBe(false);
    expect(reportsToWouldCycle(members, 'peer', 'peer')).toBe(true);
  });

  it('treats unowned work as visible and owned work as chain-scoped', () => {
    const visible = visibleMemberIds(members, 'peer');
    const users = new Set(['user-peer']);
    expect(ownerInHierarchyScope(visible, users, null)).toBe(true);
    expect(ownerInHierarchyScope(visible, users, 'peer')).toBe(true);
    expect(ownerInHierarchyScope(visible, users, 'manager')).toBe(false);
    expect(ownerInHierarchyScope(visible, users, null, 'user-peer')).toBe(true);
  });
});
