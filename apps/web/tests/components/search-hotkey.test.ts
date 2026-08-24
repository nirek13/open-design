import { describe, expect, it } from 'vitest';
import { isToggleSearchHotkey } from '../../src/components/search/search-hotkey';

function chord(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? (init.key === ' ' ? 'Space' : init.key),
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    isComposing: init.isComposing ?? false,
  } as KeyboardEvent;
}

describe('isToggleSearchHotkey', () => {
  it('matches Command-Space or Command-1 on mac and Control equivalents elsewhere', () => {
    const mac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    expect(isToggleSearchHotkey(chord({ key: ' ', metaKey: true }))).toBe(mac);
    expect(isToggleSearchHotkey(chord({ key: '1', metaKey: true }))).toBe(mac);
    expect(isToggleSearchHotkey(chord({ key: ' ', ctrlKey: true }))).toBe(!mac);
    expect(isToggleSearchHotkey(chord({ key: '1', ctrlKey: true }))).toBe(!mac);
  });

  it('ignores shifted, alted, and composing chords', () => {
    const mac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const primary = mac ? { metaKey: true } : { ctrlKey: true };
    expect(isToggleSearchHotkey(chord({ key: ' ', ...primary, shiftKey: true }))).toBe(false);
    expect(isToggleSearchHotkey(chord({ key: '1', ...primary, shiftKey: true }))).toBe(false);
    expect(isToggleSearchHotkey(chord({ key: ' ', ...primary, altKey: true }))).toBe(false);
    expect(isToggleSearchHotkey(chord({ key: ' ', ...primary, isComposing: true }))).toBe(false);
    expect(isToggleSearchHotkey(chord({ key: 'k', ...primary }))).toBe(false);
    expect(isToggleSearchHotkey(chord({ key: '2', ...primary }))).toBe(false);
  });
});
