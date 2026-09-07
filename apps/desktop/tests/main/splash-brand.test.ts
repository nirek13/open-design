import { describe, expect, test } from "vitest";

import {
  createSplashDataUrl,
  resolveSplashTheme,
  splashWindowBackground,
} from "../../src/main/splash-html.js";

function decodeSplash(theme: "light" | "dark"): string {
  const url = createSplashDataUrl({
    initialPct: 14,
    label: "Starting Plyxl",
    step: 1,
    theme,
    total: 7,
  });
  return decodeURIComponent(url.slice(url.indexOf(",") + 1));
}

describe("desktop splash brand lockup", () => {
  test("uses the Plyxl lockup instead of the Open Design intro clip", () => {
    const html = decodeSplash("dark");
    expect(html).not.toContain("splash-video");
    expect(html).not.toContain("<video");
    expect(html).toContain('aria-label="Plyxl"');
    expect(html).toContain("The Future Of Work");
  });

  test("plays a slow premium choreography", () => {
    const html = decodeSplash("dark");
    expect(html).toContain("@keyframes veil-lift");
    expect(html).toContain("@keyframes shine-sweep");
    expect(html).toContain("@keyframes letter-in");
    expect(html).toContain("@keyframes rule-draw");
    expect(html).toContain("prefers-reduced-motion");
  });

  test("resolves cream paper for light and ink for dark", () => {
    expect(resolveSplashTheme(false)).toBe("light");
    expect(resolveSplashTheme(true)).toBe("dark");
    expect(splashWindowBackground("light")).toBe("#f3eee6");
    expect(splashWindowBackground("dark")).toBe("#0c0b0a");
  });

  test("emits distinct light and dark palettes", () => {
    const light = decodeSplash("light");
    const dark = decodeSplash("dark");
    expect(light).toContain('class="theme-light"');
    expect(dark).toContain('class="theme-dark"');
    expect(light).toContain("color-scheme: light");
    expect(dark).toContain("color-scheme: dark");
    expect(light).toContain("prefers-color-scheme");
    expect(light).not.toContain('class="theme-dark"');
    expect(dark).not.toContain('class="theme-light"');
  });
});
