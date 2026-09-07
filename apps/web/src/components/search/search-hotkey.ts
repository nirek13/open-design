// Cmd+Space or Cmd+1 (mac) / Ctrl+Space or Ctrl+1 (win/linux) pulls search
// up from anywhere. Capture-phase in the renderer; Electron also forwards
// these chords when the OS would otherwise steal them (Spotlight, first tab).
// The chrome search bar next to the organization badge fires the same event.

import { isMacPlatform } from '../../utils/platform';

export const TOGGLE_SEARCH_EVENT = 'open-design:toggle-search';

function isToggleSearchKey(key: string, code: string | undefined): boolean {
  if (key === ' ' || key === 'Spacebar' || code === 'Space') return true;
  return key === '1' || code === 'Digit1';
}

export function isToggleSearchHotkey(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  if (!isToggleSearchKey(event.key, event.code)) return false;
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function searchShortcutLabel(): string {
  return isMacPlatform() ? '⌘1' : 'Ctrl+1';
}

export function requestToggleSearch(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TOGGLE_SEARCH_EVENT));
}
