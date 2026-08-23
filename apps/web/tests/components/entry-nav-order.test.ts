import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTRY_NAV_ORDER,
  dockMagnifyScale,
  DOCK_WHEEL_IDENTITY,
  dockWheelPose,
  hideEntryNavItem,
  isPinnedEntryNavId,
  moveEntryNavItem,
  normalizeEntryNavOrder,
  nudgeEntryNavItem,
  pinnedEntryNavId,
  showEntryNavItem,
} from '../../src/components/entry-nav-order';

describe('entry-nav-order', () => {
  it('keeps stored ids that still exist and appends new ones', () => {
    expect(
      normalizeEntryNavOrder(['home', 'gone', 'mail', 'home'], ['erp', 'mail', 'home', 'pages']),
    ).toEqual(['home', 'mail', 'erp', 'pages']);
  });

  it('omits hidden ids and does not resurrect them', () => {
    expect(
      normalizeEntryNavOrder(
        ['home', 'mail', 'pages'],
        ['erp', 'mail', 'home', 'pages'],
        ['mail'],
      ),
    ).toEqual(['home', 'pages', 'erp']);
  });

  it('hides and restores an item at the end', () => {
    const hidden = hideEntryNavItem(['home', 'mail', 'pages'], [], 'mail');
    expect(hidden).toEqual({ order: ['home', 'pages'], hidden: ['mail'] });
    expect(showEntryNavItem(hidden.order, hidden.hidden, 'mail')).toEqual({
      order: ['home', 'pages', 'mail'],
      hidden: [],
    });
  });

  it('falls back to available order when nothing is stored', () => {
    expect(normalizeEntryNavOrder(null, [...DEFAULT_ENTRY_NAV_ORDER])).toEqual([
      ...DEFAULT_ENTRY_NAV_ORDER,
    ]);
  });

  it('moves an item before or after a target', () => {
    const order = ['erp', 'home', 'mail'];
    expect(moveEntryNavItem(order, 'erp', 'mail', 'after')).toEqual(['home', 'mail', 'erp']);
    expect(moveEntryNavItem(order, 'mail', 'erp', 'before')).toEqual(['mail', 'erp', 'home']);
    expect(moveEntryNavItem(order, 'erp', 'erp', 'after')).toEqual(order);
  });

  it('nudges an item one slot without wrapping', () => {
    const order = ['erp', 'home', 'mail'];
    expect(nudgeEntryNavItem(order, 'home', 'up')).toEqual(['home', 'erp', 'mail']);
    expect(nudgeEntryNavItem(order, 'home', 'down')).toEqual(['erp', 'mail', 'home']);
    expect(nudgeEntryNavItem(order, 'erp', 'up')).toEqual(order);
    expect(nudgeEntryNavItem(order, 'mail', 'down')).toEqual(order);
  });

  it('tags pinned apps distinctly', () => {
    expect(pinnedEntryNavId('app-1')).toBe('pinned:app-1');
    expect(isPinnedEntryNavId('pinned:app-1')).toBe(true);
    expect(isPinnedEntryNavId('home')).toBe(false);
  });

  it('magnifies nearby dock icons with a smooth falloff', () => {
    expect(dockMagnifyScale(0)).toBeCloseTo(1.42);
    expect(dockMagnifyScale(28)).toBeGreaterThan(1);
    expect(dockMagnifyScale(56)).toBe(1);
    expect(dockMagnifyScale(80)).toBe(1);
  });

  it('leaves a fitting dock flat and tilts overflowing icons at the rim', () => {
    expect(dockWheelPose(0, 120, false)).toEqual(DOCK_WHEEL_IDENTITY);
    expect(dockWheelPose(0, 120, true)).toEqual(DOCK_WHEEL_IDENTITY);
    const rim = dockWheelPose(120, 120, true);
    expect(rim.rotateX).toBeGreaterThan(40);
    expect(rim.scale).toBeLessThan(0.75);
    expect(rim.opacity).toBeLessThan(0.4);
    expect(dockWheelPose(-120, 120, true).rotateX).toBeLessThan(0);
  });
});
