import { describe, expect, it } from "vitest";
import { isToggleSearchInput } from "../../src/main/search-shortcut.js";

const space = {
  type: "keyDown" as const,
  key: " ",
  code: "Space",
  meta: false,
  control: false,
  alt: false,
  shift: false,
};

const one = {
  ...space,
  key: "1",
  code: "Digit1",
};

describe("isToggleSearchInput", () => {
  it("matches Command-Space or Command-1 on macOS and Control equivalents elsewhere", () => {
    expect(isToggleSearchInput({ ...space, meta: true }, "darwin")).toBe(true);
    expect(isToggleSearchInput({ ...one, meta: true }, "darwin")).toBe(true);
    expect(isToggleSearchInput({ ...space, control: true }, "darwin")).toBe(false);
    expect(isToggleSearchInput({ ...one, control: true }, "darwin")).toBe(false);
    expect(isToggleSearchInput({ ...space, control: true }, "linux")).toBe(true);
    expect(isToggleSearchInput({ ...one, control: true }, "linux")).toBe(true);
    expect(isToggleSearchInput({ ...space, meta: true }, "linux")).toBe(false);
    expect(isToggleSearchInput({ ...one, control: true }, "win32")).toBe(true);
  });

  it("ignores key-up and modified chords", () => {
    expect(isToggleSearchInput({ ...space, type: "keyUp", meta: true }, "darwin")).toBe(false);
    expect(isToggleSearchInput({ ...one, type: "keyUp", meta: true }, "darwin")).toBe(false);
    expect(isToggleSearchInput({ ...space, meta: true, alt: true }, "darwin")).toBe(false);
    expect(isToggleSearchInput({ ...space, meta: true, shift: true }, "darwin")).toBe(false);
    expect(isToggleSearchInput({ ...one, meta: true, shift: true }, "darwin")).toBe(false);
  });
});
